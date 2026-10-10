use super::*;

const W: u32 = 256;
const H: u32 = 192;

/// A photo with detail everywhere and a white square "blemish" at 150..170, 80..100.
fn photo() -> Retouch {
    let mut r = Retouch::new(W, H);
    let mut rgb = Vec::with_capacity((W * H * 3) as usize);
    for y in 0..H {
        for x in 0..W {
            let blemish = (150..170).contains(&x) && (80..100).contains(&y);
            let n = ((x * 7 + y * 13) % 23) as u8;
            rgb.extend_from_slice(&if blemish { [250, 250, 250] } else { [40 + n, 110 + n, 50 + (x / 4) as u8] });
        }
    }
    // In two strips, as the worker loads it.
    let half = (W * (H / 2) * 3) as usize;
    r.load_rgb_rows(0, &rgb[..half]).unwrap();
    r.load_rgb_rows(H / 2, &rgb[half..]).unwrap();
    r.loaded();
    r
}

fn damage(v: &Value) -> (i32, i32, u32, u32) {
    let a = v["damage"].as_array().unwrap_or_else(|| panic!("no damage in {v}"));
    (a[0].as_i64().unwrap() as i32, a[1].as_i64().unwrap() as i32, a[2].as_u64().unwrap() as u32, a[3].as_u64().unwrap() as u32)
}

fn px(r: &Retouch, x: i32, y: i32) -> [u8; 4] {
    r.read(x, y, 1, 1, false).unwrap().try_into().unwrap()
}

#[test]
fn loads_and_reads_back() {
    let r = photo();
    assert_eq!(px(&r, 160, 90), [250, 250, 250, 255]);
    assert_eq!(px(&r, 0, 0), [40, 110, 50, 255]);
    // Nothing changed yet: everything is transparent in the changed-only view.
    assert!(r.read(0, 0, W, H, true).unwrap().chunks_exact(4).all(|p| p[3] == 0));
    assert!(r.read(-1, 0, 4, 4, false).is_err());
}

#[test]
fn clone_stamp_previews_live_commits_and_undoes() {
    let mut r = photo();
    let before = px(&r, 160, 90);
    // Clone from 60 px to the left onto the blemish.
    let params = json!({"points": [[152.0, 90.0]], "size": 24, "hardness": 100, "source": [92.0, 90.0], "aligned": true});
    let first = r.begin("paint.cloneStamp", params).unwrap();
    assert!(!first.is_null(), "the first dab shows on the press");
    r.push(&[json!([160.0, 90.0]), json!([168.0, 90.0])]).unwrap();
    // The preview already shows the clone.
    assert_eq!(px(&r, 160, 90), px(&r, 100, 90));
    let out = r.end().unwrap();
    let (x, y, w, h) = damage(&out);
    assert!(x <= 152 && y <= 90 && w >= 16 && h >= 16, "{out}");
    assert_eq!(px(&r, 160, 90), px(&r, 100, 90));
    assert_eq!(out["offset"], json!([-60, 0]));
    // Changed-only view: the stamped pixel shows, a far one does not.
    assert_eq!(r.read(160, 90, 1, 1, true).unwrap()[3], 255);
    assert_eq!(r.read(10, 10, 1, 1, true).unwrap()[3], 0);

    // An undo touches what the stroke touched, not the whole photo.
    assert_eq!(r.undo(), out["damage"]);
    assert_eq!(px(&r, 160, 90), before);
    assert_eq!(r.redo(), out["damage"]);
    assert_eq!(px(&r, 160, 90), px(&r, 100, 90));
}

#[test]
fn cancel_drops_the_preview() {
    let mut r = photo();
    r.begin("paint.cloneStamp", json!({"points": [[160.0, 90.0]], "size": 24, "source": [92.0, 90.0]})).unwrap();
    assert!(!r.cancel().is_null());
    assert_eq!(px(&r, 160, 90), [250, 250, 250, 255]);
    assert!(r.undo().is_null(), "a cancelled stroke left no history step");
}

#[test]
fn healing_brush_blends_into_the_surroundings() {
    let mut r = photo();
    r.begin("paint.healingBrush", json!({"points": [[160.0, 90.0]], "size": 40, "hardness": 100, "source": [60.0, 90.0]})).unwrap();
    let out = r.end().unwrap();
    damage(&out);
    assert_ne!(px(&r, 160, 90), [250, 250, 250, 255]);
}

#[test]
fn spot_healing_and_remove_take_the_blemish_out() {
    for cmd in ["paint.spotHealing", "paint.remove"] {
        let mut r = photo();
        let pts: Vec<Value> = (0..6).map(|i| json!([150.0 + f64::from(i) * 4.0, 90.0])).collect();
        let out = r.run(cmd, json!({"points": pts, "size": 34, "hardness": 100})).unwrap_or_else(|e| panic!("{cmd}: {e}"));
        damage(&out);
        let p = px(&r, 160, 90);
        assert!(p[0] < 120, "{cmd} left the white blemish: {p:?}");
        assert!(!r.undo().is_null());
        assert_eq!(px(&r, 160, 90), [250, 250, 250, 255]);
    }
}
