export const vertexShader = `
varying vec2 vUv;
uniform float breath, emphasis, pondering;
void main(){
 vUv=uv; vec3 p=position; float head=smoothstep(.40,.70,uv.y);
 p.x+=emphasis*.014*head+pondering*.013*head;
 p.y+=breath*.004*uv.y+emphasis*.014*head-pondering*.012*p.x*head;
 p.x*=1.+breath*.002*(1.-head);
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
}`

export const fragmentShader = `
varying vec2 vUv;
uniform sampler2D neutral, clean, angry, angryClean, thinking;
uniform float blend, thought, mouthActive, openness, roundness, lipWidth, lipHeight, pucker;
uniform vec2 mouthCenter, angryMouthCenter;
vec4 composite(vec4 a,vec4 b,float t){float alpha=mix(a.a,b.a,t);return vec4(mix(a.rgb*a.a,b.rgb*b.a,t)/max(alpha,.00001),alpha);}
void main(){
 vec4 n=composite(texture2D(neutral,vUv),texture2D(clean,vUv),mouthActive);
 n=composite(n,composite(texture2D(angry,vUv),texture2D(angryClean,vUv),mouthActive),blend);
 vec2 p=(vUv-mix(mouthCenter,angryMouthCenter,blend))*vec2(1024.,1134.);
 float rx=lipWidth;
 float ry=max(1.2,lipHeight)*mix(1.,.82,blend);
 float smile=clamp(p.x/rx,-1.,1.); p.y-=mix(3.,6.,blend)*smile*smile*(1.-roundness)*(1.-2.*blend);
 float distance=length(p/vec2(rx,ry));
 float aa=max(fwidth(distance),.035);
 float inside=1.-smoothstep(1.-aa,1.+aa,distance);
 vec3 ink=pow(vec3(.141,.141,.369),vec3(2.2));
 vec3 teeth=pow(vec3(1.,.978,.918),vec3(2.2));
 vec3 tongue=pow(vec3(.57,.27,.30),vec3(2.2));
 float toothBand=smoothstep(ry*.28,ry*.42,p.y)*(1.-smoothstep(ry*.69,ry*.81,p.y));
 float toothWidth=1.-smoothstep(rx*.67,rx*.81,abs(p.x));
 vec3 mouthColor=mix(ink,teeth,toothBand*toothWidth*smoothstep(.12,.3,openness));
 float tongueShape=(1.-smoothstep(.82,1.,length((p-vec2(0.,-ry*.86))/vec2(rx*.54,ry*.25))));
 mouthColor=mix(mouthColor,tongue,tongueShape*smoothstep(.45,.85,openness)*.65);
 float lipRing=(1.-smoothstep(1.12,1.28,distance))*(1.-inside)*pucker;
 n.rgb=mix(n.rgb,ink,lipRing*mouthActive*.72);
 n.rgb=mix(n.rgb,mouthColor,inside*mouthActive);
 vec4 color=n;
 color=composite(color,texture2D(thinking,vUv),thought);
 gl_FragColor=color;
 #include <tonemapping_fragment>
 #include <colorspace_fragment>
}`
