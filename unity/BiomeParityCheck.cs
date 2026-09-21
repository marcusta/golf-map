using System;
using System.IO;
using System.Globalization;
using GolfMap.Editor;
class BiomeParityCheck
{
    static double Number(string s){return double.Parse(s,CultureInfo.InvariantCulture);}
    static int Main(string[] args){
        var biome=GolfMapPalette.Load(args[0]);
        int count=0;
        foreach(var line in File.ReadLines(args[1])){
            var f=line.Split('\t');var m=GolfMapBiomeMatcher.Match(biome,f[0],Number(f[1]),Number(f[2]),int.Parse(f[3]),f.Length>8&&bool.Parse(f[8]));
            if((m==null?"-":m.asset.guid)!=f[4]||m!=null&&(Math.Abs(m.scale-Number(f[5]))>1e-9||Math.Abs(m.rotation-Number(f[6]))>1e-9||m.review!=bool.Parse(f[7])||f.Length>9&&(m.look??"-")!=f[9]))throw new Exception("JS/C# mismatch for "+f[0]);count++;
        }
        Console.WriteLine("PASS: "+count+" survey stems match JS prefab, uniform scale, rotation, review status and look.");return 0;
    }
}
