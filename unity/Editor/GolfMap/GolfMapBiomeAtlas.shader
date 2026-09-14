Shader "Hidden/GolfMap/BiomeAtlas"
{
 Properties { _MainTex("Albedo",2D)="white"{} _Color("Tint",Color)=(1,1,1,1) _Cutoff("Alpha cutoff",Float)=0.3 _BumpMap("Normal",2D)="bump"{} }
 SubShader { Cull Off Pass {
 CGPROGRAM
 #pragma vertex vert
 #pragma fragment frag
 #include "UnityCG.cginc"
 sampler2D _MainTex; float4 _MainTex_ST,_Color;float _Cutoff;
 struct v2f {float4 pos:SV_POSITION;float2 uv:TEXCOORD0;};
 v2f vert(appdata_base v){v2f o;o.pos=UnityObjectToClipPos(v.vertex);o.uv=TRANSFORM_TEX(v.texcoord,_MainTex);return o;}
 fixed4 frag(v2f i):SV_Target {fixed4 c=tex2D(_MainTex,i.uv);clip(c.a-_Cutoff);return fixed4(c.rgb*_Color.rgb,c.a);}
 ENDCG
 } }
}
