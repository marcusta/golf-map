// A big lake's far shore (golfmap.horizon.build): unlit, its texture times a tint, and NO depth write. OPCD's
// GradientFog image effect fogs every pixel with a depth by its distance (Omberg: fully by 1150 m), so a ridge 4 km
// out that wrote depth came out exactly the fog's colour and vanished into the sky. Without depth the fog treats it
// as sky (rawDepth 0) and leaves it alone; the texture carries the haze itself. Drawn after the skybox (which would
// otherwise paint over a depth-less surface) and before the transparent water, which then covers its foot.
// Nearer terrain, meshes and trees still hide it: it tests against their depth.
Shader "GolfMap/FarShore"
{
    Properties
    {
        _MainTex ("Haze (height share up the ridge in v)", 2D) = "white" {}
        _Color ("Tint", Color) = (1, 1, 1, 1)
    }
    SubShader
    {
        Tags { "Queue" = "Transparent-100" "RenderType" = "Opaque" "IgnoreProjector" = "True" }
        Cull Off
        ZWrite Off
        ZTest LEqual
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"
            sampler2D _MainTex;
            float4 _MainTex_ST;
            fixed4 _Color;
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
            v2f vert (appdata_base v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.texcoord, _MainTex);
                return o;
            }
            fixed4 frag (v2f i) : SV_Target
            {
                return fixed4(tex2D(_MainTex, i.uv).rgb * _Color.rgb, 1);
            }
            ENDCG
        }
    }
    Fallback Off
}
