// BepInEx plugin whose only job is to start the player bridge. Built by ../build.ps1 when
// BepInEx is installed next to the player, into BepInEx/plugins/GolfMapPlayerBridge/.
using BepInEx;

namespace GolfMap.Bridge.Loader
{
    [BepInPlugin("golfmap.playerbridge", "GolfMap Player Bridge", "1.0.0")]
    public sealed class BepInExLoader : BaseUnityPlugin
    {
        void Awake() { PlayerBridge.Boot(); }
    }
}
