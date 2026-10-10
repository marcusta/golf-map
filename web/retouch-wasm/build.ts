// Builds the Clean tool's pixel engine: the golfmap-retouch crate (PhotoCraft's
// retouching, see Cargo.toml) compiled to WebAssembly, with its JavaScript
// bindings written to web/src/clean/retouch-pkg. The package is committed, so
// the web app runs without a Rust toolchain; run this after changing the crate
// or pulling a newer PhotoCraft.
//
//   bun run retouch:build        (cwd web/)
//
// Needs: the PhotoCraft checkout at D:\crafts\photocraft (the path in
// Cargo.toml), `rustup target add wasm32-unknown-unknown`, and
// `cargo install wasm-bindgen-cli --version <the wasm-bindgen in Cargo.toml>`.
import { $ } from 'bun';
import * as path from 'node:path';

const crate = import.meta.dir;
const out = path.resolve(crate, '..', 'src', 'clean', 'retouch-pkg');

await $`cargo build --release --target wasm32-unknown-unknown`.cwd(crate);
await $`wasm-bindgen --target web --out-dir ${out} --out-name retouch ${path.join(crate, 'target', 'wasm32-unknown-unknown', 'release', 'golfmap_retouch.wasm')}`;

// `[Symbol.dispose]` needs a newer TypeScript lib than the app compiles with.
const dts = path.join(out, 'retouch.d.ts');
await Bun.write(dts, (await Bun.file(dts).text()).replace(/^\s*\[Symbol\.dispose\]\(\): void;\r?\n/m, ''));
console.log(`retouch-pkg: ${((await Bun.file(path.join(out, 'retouch_bg.wasm')).arrayBuffer()).byteLength / 1e6).toFixed(1)} MB wasm`);
