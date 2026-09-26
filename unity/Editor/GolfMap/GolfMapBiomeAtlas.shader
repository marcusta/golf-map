Shader "Hidden/GolfMap/BiomeAtlas"
{
 Properties { _MainTex("Albedo",2D)="white"{} _Color("Tint",Color)=(1,1,1,1) _Cutoff("Alpha cutoff",Float)=0.3 _BumpMap("Normal",2D)="bump"{} _Brightness("Brightness",Float)=1 _Saturation("Saturation",Float)=1 }
 SubShader { Cull Off Pass {
 CGPROGRAM
 #pragma vertex vert
 #pragma fragment frag
 #include "UnityCG.cginc"
 sampler2D _MainTex; float4 _MainTex_ST,_Color;float _Cutoff,_Brightness,_Saturation;
 struct v2f {float4 pos:SV_POSITION;float2 uv:TEXCOORD0;};
 v2f vert(appdata_base v){v2f o;o.pos=UnityObjectToClipPos(v.vertex);o.uv=TRANSFORM_TEX(v.texcoord,_MainTex);return o;}
 // The atlas is flat albedo: a mesh crown also gets AO and self-shadowing, so an ungraded bake reads brighter than the inner trees.
 fixed4 frag(v2f i):SV_Target {fixed4 c=tex2D(_MainTex,i.uv);clip(c.a-_Cutoff);float3 rgb=c.rgb*_Color.rgb;float luma=dot(rgb,float3(0.2126,0.7152,0.0722));float gain=_Brightness;
 #ifdef UNITY_COLORSPACE_GAMMA
 gain=pow(max(gain,0),1/2.2); // _Brightness is a linear-light multiplier, like gspro.py --darken
 #endif
 rgb=saturate(lerp(luma.xxx,rgb,_Saturation)*gain);return fixed4(rgb,c.a);}
 ENDCG
 } }
}
