// GLSL for the Lyra orb. Simplex noise: Ashima Arts / Stefan Gustavson (MIT).
//
// Layers (all additive light on a transparent canvas):
//   1 inner volume   - clustered particles, migrating density, pulsing core
//   2 cyan filaments - organic curves on/near the surface, light flowing along them
//   3 violet layer   - fewer, curvier filaments crossing the interior, sometimes leaving it
//   4 surface cloud  - irregular, deformed shell with uneven rim
//   5 external arcs  - trajectories that leave and re-enter the sphere (cyan + violet)
//   6 halo           - irregular bloom that follows the energy, violet patches
// Every layer goes through place(): one shared deformation field, so the orb
// deforms as a single energetic mass rather than as independent shells.

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

/** Palette + the deformation field shared by every layer. */
const COMMON = /* glsl */ `
uniform float uTime;
uniform float uFlowTime;
uniform float uDeform;
uniform float uCore;
uniform float uPurple;
uniform float uAlternate;
uniform float uOrbit;
uniform float uCompress;
uniform float uDisperse;
uniform float uImpulse;
uniform float uWave;
uniform float uJitter;
uniform float uHueShift;
uniform float uSize;
uniform float uPixelRatio;
const vec3 DEEP=vec3(0.07,0.28,1.0);
const vec3 CYAN=vec3(0.36,0.86,1.0);
const vec3 WHITE=vec3(0.88,0.97,1.0);
const vec3 VIOLET=vec3(0.55,0.32,1.0);
const vec3 INDIGO=vec3(0.32,0.24,0.98);
const vec3 MAGENTA=vec3(0.95,0.24,0.66);
${NOISE}
vec3 violetOf(float k){ return mix(mix(INDIGO,VIOLET,k),MAGENTA,uHueShift); }
float waveBump(){ return uWave<0.0?0.0:sin(3.14159*uWave); }
float waveFlash(float r){
  if(uWave<0.0) return 0.0;
  return exp(-pow((r-uWave*1.15)*7.0,2.0))*(1.0-uWave);
}
vec3 swirl(vec3 p){
  float a=uOrbit*0.55*sin(p.y*2.4+uTime*0.8);
  float c=cos(a), s=sin(a);
  return vec3(p.x*c-p.z*s,p.y,p.x*s+p.z*c);
}
float surfaceScale(vec3 d){
  float n=snoise(d*1.35+vec3(0.0,uTime*0.22,uTime*0.15));
  float n2=snoise(d*3.2-vec3(uTime*0.3));
  float r=1.0+uDeform*(n+0.35*n2)+sin(uTime*0.7)*0.012;
  r+=uImpulse*0.07+waveBump()*0.06;
  r+=uJitter*0.025*snoise(d*16.0+uTime*9.0);
  return r;
}
vec3 place(vec3 p){
  float l=length(p);
  vec3 d=p/max(l,1e-4);
  return swirl(d)*l*surfaceScale(d);
}
float frontOf(vec3 p){
  vec3 nv=normalize(normalMatrix*normalize(p));
  return mix(0.32,1.0,smoothstep(-0.35,0.3,nv.z));
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

/** Layer 4: irregular surface cloud. */
export const SHELL_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 d=normalize(position);
  vec3 p=place(d*(1.0+(aSeed.z-0.5)*0.06));
  p*=1.0+uDisperse*pow(aSeed.x,4.0)*0.9;
  float flare=step(0.93,aSeed.x)*max(0.0,snoise(d*1.7+vec3(t*0.2,-t*0.13,0.0)));
  p*=1.0+flare*flare*0.45;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vec3 nv=normalize(normalMatrix*d);
  float rim=pow(1.0-abs(nv.z),2.2);
  float front=mix(0.28,1.0,smoothstep(-0.3,0.35,nv.z));
  float density=smoothstep(-0.35,0.65,snoise(d*2.3+vec3(t*0.07)));
  float rimVar=0.3+0.95*smoothstep(-0.4,0.6,snoise(d*2.0-vec3(t*0.09)));
  float zone=smoothstep(0.1,0.7,snoise(d*1.4+vec3(-t*0.05,t*0.04,0.0)))*uPurple;
  float flash=waveFlash(length(p));
  vAlpha=(0.03+0.4*density+rim*rimVar*2.5)*front*(0.45+0.55*aSeed.y)*(1.0-clamp(flare*1.2,0.0,0.8))+flash*1.4;
  vec3 base=mix(DEEP,CYAN,clamp(rim*1.1+density*0.35,0.0,1.0));
  base=mix(base,WHITE,clamp(pow(rim,3.0)*0.45+flash,0.0,1.0));
  vColor=mix(base,violetOf(aSeed.y),zone*0.8);
  gl_PointSize=uSize*(0.5+aSeed.y*0.7)*(0.8+rim*0.5+density*0.3)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/** Layer 1: inner volume with migrating clusters and a pulsing core. */
export const VOLUME_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 p=position*(1.0-uCompress*0.45);
  vec3 drift=vec3(
    snoise(p*1.8+vec3(0.0,t*0.35,0.0)),
    snoise(p*1.8+vec3(17.0,t*0.35,3.0)),
    snoise(p*1.8+vec3(31.0,-t*0.35,7.0)));
  p+=drift*0.07;
  p=place(p);
  p*=1.0+uDisperse*pow(aSeed.x,3.0)*0.6;
  float r=length(p);
  float cluster=smoothstep(-0.25,0.6,snoise(position*2.2+vec3(t*0.18,-t*0.12,t*0.1)));
  float beat=0.5+0.5*sin(t*3.2);
  float core=uCore*(0.35+0.65*beat)*exp(-r*r*5.0);
  float flash=waveFlash(r);
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float zone=smoothstep(0.0,0.6,snoise(position*1.6+vec3(t*0.06)))*uPurple;
  float alt=uAlternate*(0.5+0.5*sin(t*2.3+aSeed.y*6.28));
  vColor=mix(mix(CYAN,DEEP,0.35),violetOf(aSeed.z),clamp(zone*0.85+alt*0.5,0.0,1.0));
  vColor=mix(vColor,WHITE,clamp(core*1.2+flash,0.0,1.0));
  float tw=0.6+0.4*sin(t*(1.5+aSeed.y*2.0)+aSeed.x*40.0);
  vAlpha=(0.1+0.75*cluster)*tw*(0.4+0.6*aSeed.z)*frontOf(p)+core*1.1+flash*1.1;
  gl_PointSize=uSize*(0.45+aSeed.y*0.8)*(1.0+core*1.6)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/** Layers 2, 3 and 5: filaments and external arcs drawn as dense point strips. */
export const FILAMENT_VERTEX = /* glsl */ `
${COMMON}
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uHeadSpeed;
uniform float uLife;
uniform float uIsViolet;
uniform float uArcMode;
attribute float aT;
attribute vec2 aCurve;
attribute float aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 p=position;
  p+=0.035*vec3(
    snoise(p*2.6+vec3(t*0.5,0.0,0.0)),
    snoise(p*2.6+vec3(0.0,t*0.5,11.0)),
    snoise(p*2.6+vec3(5.0,0.0,t*0.5)));
  p=place(p);
  p*=1.0+uArcMode*uImpulse*0.12;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float head=fract(aCurve.x+uFlowTime*uHeadSpeed);
  float behind=fract(head-aT);
  float comet=exp(-behind*7.0);
  float ends=pow(sin(3.14159*aT),0.7);
  float cycle=smoothstep(0.35,0.85,0.5+0.5*sin(t*0.6+aCurve.y*6.28));
  float life=mix(1.0,cycle,uLife);
  float alt=0.5+0.5*sin(t*2.2+aCurve.x*6.28);
  float altGain=mix(1.0,mix(1.0-alt,alt,uIsViolet)*1.7,uAlternate);
  float r=length(p);
  float flash=waveFlash(r)*(1.0-uIsViolet);
  float after=uWave<0.0?0.0:exp(-pow((uWave-0.55)*5.0,2.0))*uIsViolet;
  vec3 nf=normalize(normalMatrix*normalize(p));
  float rimGain=mix(0.6,1.6,pow(1.0-abs(nf.z),1.5));
  vAlpha=uIntensity*ends*life*frontOf(p)*altGain*rimGain*(0.75+1.3*comet)+flash*ends*0.9+after*ends*0.9;
  vec3 c=mix(uColorA,uColorB,comet*0.85);
  c=mix(c,MAGENTA,uHueShift*uIsViolet*0.8);
  vColor=mix(c,WHITE,clamp(flash+after*0.3,0.0,1.0));
  gl_PointSize=uSize*(0.6+comet*0.6+aSeed*0.3)*(1.0+after*0.6)*uPixelRatio/-mv.z;
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
  vAlpha=(0.25+0.35*aSeed.z)*(0.6+0.4*sin(uTime*(0.6+aSeed.y)+aSeed.x*40.0));
  vColor=mix(vec3(0.4,0.55,1.0),vec3(0.6,0.5,1.0),aSeed.y);
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

/** Layer 6: bloom that follows the energy (irregular ring, violet patches, core, flash). */
export const GLOW_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uPurple;
uniform float uCore;
uniform float uWave;
uniform float uHueShift;
uniform float uGlow;
varying vec2 vUv;
${NOISE}
${GRADE}
void main(){
  float d=length(vUv)*2.0;
  float ang=atan(vUv.y,vUv.x);
  vec3 q=vec3(cos(ang)*1.3,sin(ang)*1.3,uTime*0.12);
  float irregular=0.5+0.65*smoothstep(-0.5,0.7,snoise(q));
  float zone=smoothstep(0.05,0.7,snoise(q*1.3+vec3(9.0)))*uPurple;
  float ring=exp(-pow((d-1.0)*9.0,2.0))*0.44*irregular+exp(-pow((d-1.0)*3.0,2.0))*0.09*irregular;
  float halo=exp(-d*1.6)*0.06;
  float core=exp(-d*d*6.0)*(0.04+0.22*uCore);
  float flash=uWave<0.0?0.0:exp(-pow((d-uWave*1.15)*5.0,2.0))*(1.0-uWave)*0.6;
  vec3 violet=mix(vec3(0.5,0.3,1.0),vec3(0.95,0.24,0.66),uHueShift);
  vec3 c=mix(vec3(0.16,0.55,1.0),violet,zone*0.35)*ring
    +vec3(0.12,0.36,1.0)*halo
    +violet*halo*0.3*uPurple
    +vec3(0.6,0.85,1.0)*(core+flash);
  gl_FragColor=vec4(grade(c)*uGlow,1.0);
}
`
