// GLSL for the Lyra orb. Simplex noise: Ashima Arts / Stefan Gustavson (MIT).
//
// Built to match the reference: a luminous energy mass rather than a tangle of
// lines. Additive light on a transparent canvas, layers:
//   shell  - dense glowing sphere: strong cyan-white rim, luminous vein network,
//            violet veins and violet energy patches woven into the surface
//   core   - bright star-like particles inside, clusters, pulsing core
//   spray  - fine particles drifting around the sphere
//   violet - short violet/indigo streaks on and just outside the rim
//   arcs   - a few long, smooth, thin arcs around the sphere
//   halo   - bright rim bloom, soft outer haze, violet patches
// Every layer uses place(): one shared deformation (breathing, bulges,
// rhythm, impulses, response wave), so the orb moves as one mass.

export const NOISE = /* glsl */ `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);
  const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));
  vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);
  vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);
  vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;
  vec3 x2=x0-i2+C.yyy;
  vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;
  vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z);
  vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;
  vec4 y=y_*ns.x+ns.yyyy;
  vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);
  vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;
  vec4 s1=floor(b1)*2.0+1.0;
  vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
  vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);
  vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z);
  vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
  m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
`

/** Palette, colour shifts and the deformation field shared by every layer. */
const COMMON = /* glsl */ `
uniform float uTime;
uniform float uFlowTime;
uniform float uDeform;
uniform float uCore;
uniform float uPurple;
uniform float uVeins;
uniform float uAlternate;
uniform float uOrbit;
uniform float uCompress;
uniform float uDisperse;
uniform float uImpulse;
uniform float uWave;
uniform float uJitter;
uniform float uWarm;
uniform float uRhythm;
uniform float uArcSpread;
uniform float uSize;
uniform float uPixelRatio;
const vec3 DEEP=vec3(0.05,0.2,0.85);
const vec3 BLUE=vec3(0.12,0.46,1.0);
const vec3 CYAN=vec3(0.4,0.9,1.0);
const vec3 WHITE=vec3(0.9,0.98,1.0);
const vec3 VIOLET=vec3(0.56,0.32,1.0);
const vec3 INDIGO=vec3(0.32,0.22,0.98);
${NOISE}
vec3 warmShift(vec3 c){
  float v=clamp((c.r-c.g)*1.6+0.2,0.0,1.0);
  vec3 rose=mix(vec3(c.b*1.0+0.1,c.g*0.28+0.05,c.b*0.3),vec3(c.b*0.95,c.g*0.2,c.b*0.95),v);
  return mix(c,rose,uWarm);
}
float beat(){ float b=0.5+0.5*sin(uTime*4.2); return b*b; }
float waveBump(){ return uWave<0.0?0.0:sin(3.14159*uWave); }
float waveFlash(float r){
  if(uWave<0.0) return 0.0;
  float k=(r-uWave*1.2)*7.0;
  return exp(-k*k)*(1.0-uWave);
}
vec3 swirl(vec3 p){
  float a=uOrbit*0.5*sin(p.y*2.4+uTime*0.8);
  float c=cos(a), s=sin(a);
  return vec3(p.x*c-p.z*s,p.y,p.x*s+p.z*c);
}
float surfaceScale(vec3 d){
  float n=snoise(d*1.3+vec3(0.0,uTime*0.2,uTime*0.14));
  float n2=snoise(d*3.1-vec3(uTime*0.28));
  float r=1.0+uDeform*(n+0.35*n2)+sin(uTime*0.6)*0.014;
  r+=uRhythm*(0.03*beat()+0.012*n);
  r+=uImpulse*0.07+waveBump()*0.07;
  r+=uJitter*0.022*snoise(d*16.0+uTime*9.0);
  return r;
}
vec3 place(vec3 p){
  float l=length(p);
  vec3 d=p/max(l,1e-4);
  return swirl(d)*l*surfaceScale(d);
}
float frontOf(vec3 p){
  vec3 nv=normalize(normalMatrix*normalize(p));
  return mix(0.3,1.0,smoothstep(-0.35,0.3,nv.z));
}
float violetZone(vec3 d){
  return smoothstep(0.05,0.6,snoise(d*1.15+vec3(uTime*0.03,0.0,-uTime*0.02)));
}
`

export const GRADE = /* glsl */ `
uniform float uBrightness;
uniform float uSaturation;
vec3 grade(vec3 c){
  float l=dot(c,vec3(0.299,0.587,0.114));
  return mix(vec3(l),c,uSaturation)*uBrightness;
}
`

export const POINT_FRAGMENT = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
${GRADE}
void main(){
  float d=length(gl_PointCoord-0.5);
  float a=smoothstep(0.5,0.0,d);
  gl_FragColor=vec4(grade(vColor)*a*a*vAlpha,1.0);
}
`

/** The luminous shell: rim, vein network, violet veins and patches. */
export const SHELL_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  float ft=uFlowTime;
  vec3 d=normalize(position);
  vec3 p=place(d*(1.0+(aSeed.z-0.5)*0.03));
  p*=1.0+uDisperse*pow(aSeed.x,5.0)*1.1;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vec3 nv=normalize(normalMatrix*d);
  float rim=pow(1.0-abs(nv.z),1.8);
  float front=mix(0.3,1.0,smoothstep(-0.3,0.3,nv.z));
  float v1=max(0.0,1.0-abs(snoise(d*2.1+vec3(ft*0.08,-ft*0.05,t*0.02))));
  float v2=max(0.0,1.0-abs(snoise(d*4.3-vec3(t*0.03,ft*0.07,0.0))));
  float vein=(pow(v1,7.0)+pow(v2,9.0)*0.7)*uVeins;
  float zone=violetZone(d)*uPurple;
  float vv=pow(max(0.0,1.0-abs(snoise(d*3.0+vec3(17.0,t*0.04,ft*0.05)))),11.0)*zone;
  float alt=0.5+0.5*sin(t*2.1+d.x*3.0);
  float altC=mix(1.0,0.5+(1.0-alt),uAlternate);
  float altV=mix(1.0,0.5+alt,uAlternate);
  float flash=waveFlash(length(p));
  float a=(0.04+rim*1.5)*front+vein*1.9*front*altC+vv*1.7*front*altV+zone*0.12*front+flash*1.3;
  vec3 c=mix(DEEP,CYAN,clamp(rim*1.2+vein*1.4,0.0,1.0));
  c=mix(c,WHITE,clamp(pow(rim,2.5)*0.6+pow(vein,1.5)*0.5+flash,0.0,1.0));
  c=mix(c,mix(INDIGO,VIOLET,aSeed.y),clamp(vv*2.2+zone*0.35,0.0,1.0));
  vColor=warmShift(c);
  vAlpha=a*(0.55+0.45*aSeed.y);
  gl_PointSize=uSize*(0.6+aSeed.y*0.6)*(0.8+rim*0.5+vein*0.9+vv*0.7)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/** Bright star-like particles inside, migrating clusters and a pulsing core. */
export const CORE_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 p=position*(1.0-uCompress*0.4);
  p+=0.05*vec3(
    snoise(p*1.8+vec3(0.0,t*0.35,0.0)),
    snoise(p*1.8+vec3(17.0,t*0.35,3.0)),
    snoise(p*1.8+vec3(31.0,-t*0.35,7.0)));
  p=place(p);
  float r=length(p);
  float cluster=smoothstep(-0.3,0.6,snoise(position*2.2+vec3(t*0.18,-t*0.12,t*0.1)));
  float core=uCore*(0.35+0.65*(0.5+0.5*sin(t*3.2)))*exp(-r*r*5.0);
  float flash=waveFlash(r);
  float tw=0.55+0.45*sin(t*(1.5+aSeed.y*2.0)+aSeed.x*40.0);
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float zone=violetZone(normalize(position+1e-4))*uPurple;
  vec3 c=mix(CYAN,WHITE,aSeed.z*0.6);
  c=mix(c,VIOLET,clamp(zone*0.55*aSeed.y+uAlternate*0.3*(0.5+0.5*sin(t*2.3+aSeed.y*6.28)),0.0,1.0));
  vColor=warmShift(mix(c,WHITE,clamp(core+flash,0.0,1.0)));
  vAlpha=(0.18+0.62*cluster)*tw*(0.35+0.65*aSeed.z)*frontOf(p)+core*1.1+flash;
  gl_PointSize=uSize*(0.4+aSeed.y*0.9)*(1.0+core*1.4)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/** Fine particles drifting around the sphere; dispersion pushes them further out. */
export const SPRAY_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 d=normalize(position);
  float life=fract(aSeed.x+t*0.018*(1.0+uDisperse*4.0));
  float reach=0.45+uDisperse*0.7;
  float r=1.0+reach*pow(life,1.6)*(0.4+0.6*aSeed.y);
  vec3 p=place(d)*r;
  p+=0.04*vec3(snoise(d*3.0+t*0.3),snoise(d*3.0+17.0+t*0.3),snoise(d*3.0+31.0-t*0.3));
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float fade=(1.0-life)*smoothstep(0.0,0.08,life);
  float zone=violetZone(d)*uPurple;
  vec3 c=mix(BLUE,CYAN,aSeed.z);
  c=mix(c,VIOLET,step(0.72,aSeed.y)*clamp(zone+0.3,0.0,1.0));
  vColor=warmShift(c);
  vAlpha=fade*(0.4+0.8*aSeed.z)*frontOf(p);
  gl_PointSize=uSize*(0.35+aSeed.z*0.6)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/** Violet streaks and the long thin arcs, drawn as dense point strips. */
export const STREAK_VERTEX = /* glsl */ `
${COMMON}
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uHeadSpeed;
uniform float uIsArc;
attribute float aT;
attribute vec2 aCurve;
attribute float aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 p=position;
  float out1=smoothstep(1.02,1.25,length(p));
  p*=mix(1.0,uArcSpread,out1*uIsArc);
  p+=mix(0.02,0.045,uIsArc)*vec3(snoise(p*3.0+t*0.4),snoise(p*3.0+11.0+t*0.4),snoise(p*3.0+23.0-t*0.4));
  p=place(p);
  p*=1.0+uIsArc*uImpulse*0.1;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float head=fract(aCurve.x+uFlowTime*uHeadSpeed);
  float comet=exp(-fract(head-aT)*6.0);
  float ends=pow(max(0.0,sin(3.14159*aT)),1.2);
  float cycle=mix(1.0,smoothstep(0.2,0.8,0.5+0.5*sin(t*0.5+aCurve.y*6.28)),uIsArc*0.6);
  float flicker=mix(1.0,step(0.35,fract(sin(dot(vec2(aCurve.y,floor(t*6.0)),vec2(12.9,78.2)))*43758.5)),uJitter*uIsArc);
  float flash=waveFlash(length(p));
  vAlpha=uIntensity*ends*cycle*flicker*frontOf(p)*(0.5+1.0*comet)+flash*ends*0.6;
  vColor=warmShift(mix(mix(uColorA,uColorB,comet),WHITE,flash));
  gl_PointSize=uSize*(0.55+comet*0.7+aSeed*0.25)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

export const STAR_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.0);
  vAlpha=(0.2+0.35*aSeed.z)*(0.6+0.4*sin(uTime*(0.6+aSeed.y)+aSeed.x*40.0));
  vColor=mix(vec3(0.4,0.6,1.0),vec3(0.55,0.5,1.0),aSeed.y);
  gl_PointSize=uSize*(0.4+aSeed.y*0.6)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

export const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv=uv*2.0-1.0;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`

/** Bright rim bloom, outer haze, violet patches, core light, response flash. */
export const GLOW_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uPurple;
uniform float uCore;
uniform float uWave;
uniform float uWarm;
uniform float uRhythm;
uniform float uGlow;
uniform float uFlare;
varying vec2 vUv;
${NOISE}
${GRADE}
vec3 warmShift(vec3 c){
  float v=clamp((c.r-c.g)*1.6+0.2,0.0,1.0);
  vec3 rose=mix(vec3(c.b*1.0+0.1,c.g*0.28+0.05,c.b*0.3),vec3(c.b*0.95,c.g*0.2,c.b*0.95),v);
  return mix(c,rose,uWarm);
}
void main(){
  float d=length(vUv)*2.0;
  // Angular patterns from the unit direction (no atan: imprecise near the axes on some GPUs).
  vec2 n=vUv/max(length(vUv),1e-4);
  vec3 q=vec3(mat2(0.8,0.6,-0.6,0.8)*n*1.3+vec2(3.7,1.3),uTime*0.1);
  float irregular=0.65+0.5*smoothstep(-0.5,0.7,snoise(q));
  float zone=smoothstep(0.0,0.6,snoise(q*1.2+vec3(9.0,0.0,uTime*0.05)))*uPurple;
  float bt=0.5+0.5*sin(uTime*4.2);
  float pulse=1.0+uRhythm*0.3*bt*bt;
  float e1=(d-1.0)*12.0, e2=(d-1.0)*4.2;
  float ring=exp(-e1*e1)*0.6*irregular+exp(-e2*e2)*0.2*irregular;
  float haze=d>1.0?exp(-(d-1.0)*2.4)*0.13:0.05+0.08*smoothstep(0.6,1.0,d);
  float inner=smoothstep(1.02,0.15,d)*0.04;
  float edge=smoothstep(2.0,1.45,d);
  float rays=pow(max(0.0,1.0-abs(snoise(vec3(n*4.0,uTime*0.3)))),18.0)+pow(max(0.0,1.0-abs(snoise(vec3(n*7.0+9.0,uTime*0.2)))),26.0)*0.7;
  float burst=uFlare*(exp(-d*d*5.0)*0.55+rays*exp(-d*2.2)*0.5*(0.7+0.3*sin(uTime*3.0)));
  float core=exp(-d*d*7.0)*(0.03+0.26*uCore);
  float fw=(d-uWave*1.2)*5.0;
  float flash=uWave<0.0?0.0:exp(-fw*fw)*(1.0-uWave)*0.7;
  vec3 ringColor=mix(vec3(0.3,0.78,1.0),vec3(0.55,0.32,1.0),zone*0.75);
  vec3 c=ringColor*ring
    +vec3(0.1,0.3,0.95)*haze
    +vec3(0.5,0.3,1.0)*zone*0.12*exp(-abs(d-1.02)*9.0)
    +vec3(0.75,0.7,1.0)*burst
    +vec3(0.04,0.14,0.5)*inner
    +vec3(0.65,0.9,1.0)*(core+flash);
  gl_FragColor=vec4(grade(warmShift(c))*uGlow*pulse*edge,1.0);
}
`
