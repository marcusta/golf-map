using System;
using System.IO;
using System.Globalization;
using GolfMap.Editor;
class BiomeParityCheck
{
    static double Number(string s){return double.Parse(s,CultureInfo.InvariantCulture);}
    // `<species>:<weight>,...;<ignoreKind 0|1>`, '-' = the stem is in no tree species area.
    static GolfMapAreaMix Area(string[] f){
        if(f.Length<13||f[12]=="-")return null;
        var parts=f[12].Split(';');var mix=new GolfMapAreaMix{ignoreKind=parts[1]=="1"};
        foreach(var s in parts[0].Split(',')){var kv=s.Split(':');if(Number(kv[1])>0)mix.weights[kv[0]]=Number(kv[1]);}
        return mix;
    }
    static int Main(string[] args){
        var biome=GolfMapPalette.Load(args[0]);
        int count=0;
        foreach(var line in File.ReadLines(args[1])){
            var f=line.Split('\t');var m=GolfMapBiomeMatcher.Match(biome,f[0],Number(f[1]),Number(f[2]),int.Parse(f[3]),f.Length>8&&bool.Parse(f[8]),Area(f));
            if((m==null?"-":m.asset.MatchKey)!=f[4]||m!=null&&(Math.Abs(m.scale-Number(f[5]))>1e-9||Math.Abs(m.rotation-Number(f[6]))>1e-9||m.review!=bool.Parse(f[7])||f.Length>9&&(m.look??"-")!=f[9]||f.Length>11&&(Math.Abs(m.lean-Number(f[10]))>1e-9||Math.Abs(m.leanDirection-Number(f[11]))>1e-9)))throw new Exception("JS/C# mismatch for "+f[0]);count++;
        }
        Console.WriteLine("PASS: "+count+" survey stems match JS prefab, uniform scale, rotation, review status, look, lean and tree species area.");return 0;
    }
}
