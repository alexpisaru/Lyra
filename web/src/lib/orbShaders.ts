// GLSL for the Lyra orb. Simplex noise: Ashima Arts / Stefan Gustavson (MIT).

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

/** Shared colour grading: electric blue/cyan base, violet accents, state tint. */
export const GRADE = /* glsl */ `
uniform float uBrightness;
uniform float uHueShift;
uniform float uSaturation;
vec3 grade(vec3 c){
  vec3 tint=mix(c, c*vec3(1.35,0.55,1.15), clamp(uHueShift,0.0,1.0));
  float l=dot(tint,vec3(0.299,0.587,0.114));
  return mix(vec3(l),tint,uSaturation)*uBrightness;
}
`

export const SHELL_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uTurb;
uniform float uCohesion;
uniform float uPulse;
uniform float uOrbit;
uniform float uSize;
uniform float uPixelRatio;
attribute vec3 aSeed;
varying float vAlpha;
varying float vRidge;
varying float vRim;
varying float vViolet;
${NOISE}
void main(){
  vec3 p=normalize(position);
  float t=uTime;
  float n=snoise(p*1.8+vec3(0.0,t*0.32,t*0.21));
  float n2=snoise(p*4.6-vec3(t*0.45));
  float r=1.0+uPulse+n*uTurb*0.6+n2*uTurb*0.2+(aSeed.z-0.5)*0.02;
  r+=(1.0-uCohesion)*pow(aSeed.x,3.0)*1.4;
  float flare=step(0.9,aSeed.x)*max(0.0,snoise(p*1.6+vec3(t*0.18,-t*0.12,0.0)));
  r+=flare*flare*0.55;
  float swirl=uOrbit*0.55*sin(p.y*3.2+t*0.9);
  float cs=cos(swirl), sn=sin(swirl);
  vec3 q=vec3(p.x*cs-p.z*sn,p.y,p.x*sn+p.z*cs);
  vec4 mv=modelViewMatrix*vec4(q*r,1.0);
  vec3 nv=normalize(normalMatrix*q);
  float rim=pow(1.0-abs(nv.z),2.4);
  float front=mix(0.28,1.0,smoothstep(-0.25,0.35,nv.z));
  float ridge=1.0-abs(snoise(p*1.9+vec3(t*0.06,-t*0.05,t*0.04)));
  ridge=pow(ridge,5.0);
  float vein=1.0-abs(snoise(p*6.5+vec3(t*0.1)));
  ridge=max(ridge,pow(vein,14.0)*0.8);
  vRidge=ridge;
  vRim=rim;
  vViolet=smoothstep(0.05,0.55,snoise(p*1.25+vec3(t*0.04,0.0,-t*0.03)));
  float fade=1.0-clamp(flare*1.4,0.0,0.85);
  vAlpha=(0.012+ridge*1.15+pow(rim,1.8)*1.0)*front*(0.5+0.5*aSeed.y)*fade;
  gl_PointSize=uSize*(0.5+aSeed.y*0.8)*(0.62+ridge*1.25+rim*0.45)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

export const SHELL_FRAGMENT = /* glsl */ `
varying float vAlpha;
varying float vRidge;
varying float vRim;
varying float vViolet;
${GRADE}
void main(){
  float d=length(gl_PointCoord-0.5);
  float a=smoothstep(0.5,0.0,d);
  a*=a;
  vec3 deep=vec3(0.07,0.28,1.0);
  vec3 cyan=vec3(0.35,0.85,1.0);
  vec3 white=vec3(0.85,0.96,1.0);
  vec3 violet=vec3(0.55,0.33,1.0);
  vec3 c=mix(deep,cyan,clamp(vRidge*1.5+pow(vRim,0.8)*1.1,0.0,1.0));
  c=mix(c,white,clamp(pow(vRidge,3.0)*0.6+pow(vRim,3.0)*0.35,0.0,0.8));
  c=mix(c,violet,vViolet*0.6);
  gl_FragColor=vec4(grade(c)*a*vAlpha,1.0);
}
`

export const DUST_VERTEX = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
uniform float uCohesion;
uniform float uSpread;
attribute vec3 aSeed;
varying float vAlpha;
void main(){
  vec3 p=position;
  float t=uTime;
  p+=0.04*vec3(sin(t*0.7+aSeed.x*20.0),cos(t*0.6+aSeed.y*20.0),sin(t*0.5+aSeed.z*20.0));
  p*=1.0+(1.0-uCohesion)*uSpread*aSeed.x;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float tw=0.55+0.45*sin(t*(1.2+aSeed.y*2.0)+aSeed.x*40.0);
  vAlpha=tw*(0.35+0.65*aSeed.z);
  gl_PointSize=uSize*(0.5+aSeed.y)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

export const DUST_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
${GRADE}
void main(){
  float d=length(gl_PointCoord-0.5);
  float a=smoothstep(0.5,0.0,d);
  gl_FragColor=vec4(grade(uColor)*a*a*vAlpha*uOpacity,1.0);
}
`

export const ARC_VERTEX = /* glsl */ `
attribute float aT;
varying float vT;
void main(){
  vT=aT;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`

export const ARC_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uPhase;
varying float vT;
${GRADE}
void main(){
  float body=sin(3.14159*vT);
  float head=smoothstep(0.0,1.0,fract(vT-uPhase));
  float a=body*(0.25+0.75*pow(head,3.0))*uOpacity;
  gl_FragColor=vec4(grade(uColor)*a,1.0);
}
`

export const GLOW_VERTEX = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv=uv*2.0-1.0;
  gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
}
`

export const GLOW_FRAGMENT = /* glsl */ `
uniform float uOpacity;
uniform float uRadius;
varying vec2 vUv;
${GRADE}
void main(){
  float d=length(vUv)*2.0;
  float core=exp(-d*d*2.2)*0.05;
  float ring=exp(-pow((d-uRadius)*7.0,2.0))*0.5+exp(-pow((d-uRadius)*2.6,2.0))*0.16;
  float halo=exp(-d*1.4)*0.08;
  vec3 c=vec3(0.12,0.4,1.0)*(core+halo)+vec3(0.16,0.58,1.0)*ring+vec3(0.35,0.2,0.9)*halo*0.45;
  gl_FragColor=vec4(grade(c)*uOpacity,1.0);
}
`
