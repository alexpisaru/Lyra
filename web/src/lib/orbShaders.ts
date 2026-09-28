// GLSL for the Lyra orb. Simplex noise: Ashima Arts / Stefan Gustavson (MIT).
//
// Target: the reference orb. A sphere of blue-cyan energy that reads as a
// sphere because its rim is far brighter than its centre:
//   shell      - thick rim of many particles, brighter and dimmer sectors,
//                violet-magenta where the violet zones are; dark face
//   core       - dark, star-filled interior (sharp twinkling points)
//   mesh       - a net of bright nodes linked into irregular cells over the whole
//                sphere, brightest at the rim, visible on the face, dim behind
//   spray      - particles past the rim, denser on one side, evaporating
//   trails     - open energy wisps (soft ribbons) that grow out of the rim, sway,
//                fade and are reborn elsewhere; bright at the root, thin at the tip
//   halo       - soft cyan bloom around the rim, violet glow in the violet zones
// No white flash anywhere: the response is a cyan wave + more crackle + violet
// afterglow + particle expansion.
// Every layer uses place(): one shared deformation (breathing, bulges,
// rhythm, impulses, response wave), so the orb moves as one mass.
//
// No pow() with a possibly negative base and no atan(): both are undefined or
// imprecise on some GPUs (they drew rectangular bands in the halo).

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
uniform float uPlasma;
uniform float uAlternate;
uniform float uOrbit;
uniform float uCompress;
uniform float uDisperse;
uniform float uImpulse;
uniform float uWave;
uniform float uAfterglow;
uniform float uDischarge;
uniform float uJitter;
uniform float uWarm;
uniform float uRhythm;
uniform float uFluxReach;
uniform float uSize;
uniform float uPixelRatio;
const vec3 DEEP=vec3(0.05,0.2,0.85);
const vec3 BLUE=vec3(0.12,0.46,1.0);
const vec3 CYAN=vec3(0.18,0.72,1.0);
const vec3 WHITE=vec3(0.9,0.98,1.0);
const vec3 VIOLET=vec3(0.56,0.32,1.0);
const vec3 INDIGO=vec3(0.32,0.22,0.98);
const vec3 MAGENTA=vec3(0.78,0.3,1.0);
uniform float uRim;
uniform float uMorph;
uniform float uShrink;
uniform float uScatter;
uniform float uFlatten;
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
  // speaking: irregular, syllable-like pulses that differ across the surface
  float syll=abs(snoise(vec3(uTime*2.3,5.0,0.0)));
  r+=uRhythm*(0.03*beat()*(0.6+0.8*abs(snoise(vec3(uTime*0.9,1.0,2.0))))+0.05*n2*syll+0.012*n);
  r+=uImpulse*0.07+waveBump()*0.07;
  r+=uJitter*0.022*snoise(d*16.0+uTime*9.0);
  return r;
}
// Sphere -> ring, the irregular way (DEV experiment). Every layer goes through
// place(), so the whole filament structure deforms together.
// toRing: an uneven ring around Y. Radius, tube thickness and height vary along
// the ring and over time, so it has clumps, thin stretches and waves.
// The horizontal direction gives the angle around the ring, the latitude the
// angle around the tube (no atan).
vec3 toRing(vec3 d,float l){
  vec2 h=d.xz/max(length(d.xz),1e-4);
  float lat=asin(clamp(d.y,-1.0,1.0))*2.0;
  float t=uTime*0.25;
  // bunching: slide points along the ring so they gather into a few dense (bright) clumps
  float slide=0.55*snoise(vec3(h*1.3+17.0,t*0.6));
  float cs=cos(slide), sn=sin(slide);
  h=vec2(h.x*cs-h.y*sn,h.x*sn+h.y*cs);
  float clump=smoothstep(-0.6,0.7,snoise(vec3(h*1.6,t)));
  float tube=l*(0.1+0.32*clump);
  float R=0.95+0.2*snoise(vec3(h*1.2+7.0,t*0.8))+tube*cos(lat);
  float y=tube*sin(lat)*1.2+0.18*snoise(vec3(h*1.1+3.0,t*0.7));
  // flatten phase: squeeze into a compact, flat oblique ellipse
  return vec3(h.x*R*(1.0-0.3*uFlatten),y*(1.0-0.75*uFlatten),h.y*R*(1.0-0.05*uFlatten));
}
// Pieces of the sphere leave at different moments and in their own directions.
float morphDelay(vec3 d){ return 0.5+0.5*snoise(d*1.9+vec3(11.0,0.0,5.0)); }
vec3 scatterDir(vec3 d){
  return normalize(d+0.8*vec3(snoise(d*1.1+21.0),snoise(d*1.1+37.0),snoise(d*1.1+53.0)));
}
vec3 place(vec3 p){
  float l=length(p);
  vec3 d=p/max(l,1e-4);
  vec3 s=swirl(d)*l*surfaceScale(d);
  if(uMorph>0.001||uScatter>0.001){
    float delay=morphDelay(d);
    // staggered: each region turns into the ring on its own schedule
    float m=clamp(uMorph*1.7-delay*0.7,0.0,1.0);
    m=m*m*(3.0-2.0*m);
    s=mix(s,toRing(swirl(d),l)*surfaceScale(d),m);
    // decomposition: chunks drift out along their own directions, some further
    float amount=uScatter*(0.35+0.75*delay)*(0.6+0.4*l);
    s+=scatterDir(d)*amount*(0.7+0.3*sin(uTime*1.1+delay*2.0));
  }
  return s*uShrink;
}
float frontOf(vec3 p){
  vec3 nv=normalize(normalMatrix*normalize(p));
  return mix(0.3,1.0,smoothstep(-0.35,0.3,nv.z));
}
float violetZone(vec3 d){
  float n=snoise(d*1.1+vec3(uTime*0.03,0.0,-uTime*0.02))*0.7+snoise(d*2.6-vec3(0.0,uTime*0.05,uTime*0.03))*0.45;
  return smoothstep(-0.35,0.55,n);
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

/**
 * The sphere: a thick rim made of many particles, brighter in some sectors,
 * turning violet-magenta where the violet zones are; a dark face.
 */
export const SHELL_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 d=normalize(position);
  vec3 p=place(d*(1.0+(aSeed.z-0.5)*0.045));
  float s5=aSeed.x*aSeed.x*aSeed.x*aSeed.x*aSeed.x;
  p*=1.0+uDisperse*s5*1.1+waveBump()*0.04*aSeed.z;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vec3 nv=normalize(normalMatrix*d);
  float edge=1.0-abs(nv.z);
  float rim=pow(max(edge,0.0),4.5);
  float front=mix(0.3,1.0,smoothstep(-0.3,0.3,nv.z));
  // brighter and dimmer sectors along the rim (never a uniform circle)
  float sector=0.55+0.75*smoothstep(-0.5,0.7,snoise(d*1.25+vec3(0.0,t*0.04,t*0.03)));
  float cloud=smoothstep(0.2,0.9,snoise(d*1.8+vec3(uFlowTime*0.05,-t*0.03,0.0)))*uPlasma;
  float zone=violetZone(d)*uPurple;
  float alt=0.5+0.5*sin(t*2.1+d.x*3.0);
  float sparkle=step(0.94,aSeed.y);
  float a=(0.035+rim*1.25*sector*uRim)*front+cloud*0.25*front+sparkle*0.5*front;
  vec3 c=mix(DEEP,CYAN,clamp(rim*1.3+cloud*0.5,0.0,1.0));
  c=mix(c,CYAN,clamp(sparkle*0.5,0.0,1.0));
  float v=0.0; // violet lives in the mesh filaments, not on the shell
  c=mix(c,mix(INDIGO,VIOLET,0.55+0.3*aSeed.y),v*0.8);
  vColor=warmShift(c);
  // violet replaces cyan brightness instead of adding to it (no white pile-up)
  vAlpha=a*(0.55+0.45*aSeed.y)*(1.0-v*0.35);
  gl_PointSize=uSize*(0.6+aSeed.y*0.6)*(0.85+rim*0.55+v*0.25)*(1.0+sparkle*1.2)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/** A dark, star-filled interior: sharp twinkling points, a soft pulsing core (never white). */
export const CORE_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 p=position*(1.0-uCompress*0.4);
  p+=0.04*vec3(
    snoise(p*1.8+vec3(0.0,t*0.35,0.0)),
    snoise(p*1.8+vec3(17.0,t*0.35,3.0)),
    snoise(p*1.8+vec3(31.0,-t*0.35,7.0)));
  p=place(p);
  p*=1.0+waveBump()*0.05;
  float r=length(p);
  float cluster=smoothstep(-0.3,0.6,snoise(position*2.2+vec3(t*0.18,-t*0.12,t*0.1)));
  float core=uCore*(0.35+0.65*(0.5+0.5*sin(t*3.2)))*exp(-r*r*5.0);
  float tw=0.5+0.5*sin(t*(1.5+aSeed.y*2.0)+aSeed.x*40.0);
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float zone=violetZone(normalize(position+1e-4))*uPurple;
  vec3 c=mix(BLUE,CYAN,aSeed.z);
  c=mix(c,WHITE,step(0.93,aSeed.z)*0.35);
  c=mix(c,BLUE,step(0.7,aSeed.x)*0.6);
  c=mix(c,VIOLET,clamp(zone*0.45*aSeed.y+uAlternate*0.3*(0.5+0.5*sin(t*2.3+aSeed.y*6.28)),0.0,1.0));
  vColor=warmShift(mix(c,BLUE,clamp(core,0.0,1.0)*0.5));
  float big=aSeed.y*aSeed.y*aSeed.y;
  vec3 centre=(modelViewMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
  float radial=length(mv.xy-centre.xy)/max(length(modelViewMatrix[0].xyz),1e-4);
  float keep=mix(0.12,1.0,smoothstep(0.15,0.85,radial+0.4*snoise(position*1.6+vec3(0.0,t*0.03,7.0))));
  vAlpha=keep*(0.4+0.9*cluster)*tw*(0.4+0.6*aSeed.z)*frontOf(p)*(1.0+big*1.2)+core*0.35;
  gl_PointSize=uSize*(0.45+big*1.6)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/**
 * Particle spray past the rim: denser on the left of the view (as in the
 * reference), thinning out as it drifts away.
 */
export const SPRAY_VERTEX = /* glsl */ `
${COMMON}
attribute vec3 aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 d=normalize(position);
  vec3 nv=normalize(normalMatrix*d);
  float side=0.5+0.25*snoise(d*1.3+vec3(0.0,t*0.05,0.0));
  float life=fract(aSeed.x+t*0.018*(1.0+uDisperse*4.0));
  float reach=0.3+side*0.75+uDisperse*0.7+waveBump()*0.3;
  float r=1.0+reach*pow(life,1.5)*(0.4+0.6*aSeed.y);
  vec3 p=place(d)*r;
  p+=0.04*vec3(snoise(d*3.0+t*0.3),snoise(d*3.0+17.0+t*0.3),snoise(d*3.0+31.0-t*0.3));
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  float fade=(1.0-life)*(1.0-life)*smoothstep(0.0,0.06,life);
  float zone=violetZone(d)*uPurple;
  vec3 c=mix(BLUE,CYAN,aSeed.z);
  c=mix(c,VIOLET,step(0.75,aSeed.y)*clamp(zone+0.25,0.0,1.0));
  vColor=warmShift(c);
  float speck=aSeed.z*aSeed.z*aSeed.z;
  vAlpha=fade*(0.55+1.3*aSeed.z)*(0.55+1.2*side)*frontOf(p);
  gl_PointSize=uSize*(0.35+aSeed.z*0.5+speck*1.8)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/**
 * Energy mesh: nodes linked into irregular cells over the whole sphere,
 * brightest at the rim, clearly visible on the face, dimmer on the far side;
 * regions of the net brighten and fade, sparks run along the links, nodes
 * glow; violet-magenta inside the violet zones.
 * Per point: aT along its link, aSeg = (link id, 1 for a node), aSeed.
 */
export const DISCHARGE_VERTEX = /* glsl */ `
${COMMON}
uniform float uWeight;
attribute float aT;
attribute vec2 aSeg;
attribute float aSeed;
varying float vAlpha;
varying vec3 vColor;
void main(){
  float t=uTime;
  vec3 d=normalize(position);
  vec3 p=place(d*1.006);
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vec3 nv=normalize(normalMatrix*d);
  float edge=1.0-abs(nv.z);
  float limb=smoothstep(0.15,0.9,edge);
  // the web covers the whole sphere: strongest at the rim, clearly visible on the
  // face, dimmer on the far hemisphere (seen through the front: depth)
  // an irregular emptier centre: the net thins out towards the middle, with a noisy edge
  float keep=smoothstep(0.0,0.9,limb+0.5*snoise(d*1.7+vec3(3.1,t*0.02,0.0)));
  float vis=mix(0.14,0.8,keep)*mix(0.3,1.0,smoothstep(-0.3,0.2,nv.z));
  // sections of each filament brighten and fade (woven energy, not uniform wires)
  float seg=0.5+0.5*smoothstep(-0.35,0.55,snoise(d*2.6+vec3(t*0.08,-t*0.05,aSeg.x*3.0)));
  float node=aSeg.y;
  float rate=0.8+2.2*fract(aSeg.x*7.31);
  float on=0.55+0.45*smoothstep(0.15,0.85,0.5+0.5*sin(uFlowTime*rate*2.6+t*0.4+aSeg.x*40.0));
  float spark=(1.0-node)*exp(-fract(aT-uFlowTime*(0.4+rate*0.2)-aSeg.x)*6.0);
  float ends=1.0;
  float zone=violetZone(d)*uPurple;
  // violet belongs to whole filaments: each link is violet or not (plus a slow zone bias)
  float pick=fract(sin(aSeg.x*91.37)*43758.55);
  float v=smoothstep(0.0,0.12,uPurple*(0.24+0.22*zone+0.12*uAfterglow)-pick);
  float jit=mix(1.0,step(0.4,fract(sin(dot(vec2(aSeg.x,floor(t*8.0)),vec2(12.9,78.2)))*43758.5)),uJitter);
  float wave=waveFlash(length(p));
  // no white in the mesh; denser parts (towards the rim) go deeper blue so overlaps stay blue
  vec3 c=mix(CYAN,BLUE,0.35+0.4*limb);
  c=mix(c,mix(INDIGO,VIOLET,0.55+0.4*aSeed),v);
  vColor=warmShift(c);
  vAlpha=uWeight*uDischarge*2.4*vis*seg*ends*jit*on*(0.55+0.6*spark)*(0.65+0.35*aSeed)*(1.0+0.5*node)*(1.0-v*0.1)*0.85+wave*vis*ends*0.15;
  gl_PointSize=uSize*(0.7+0.4*aSeed)*(1.0+0.25*limb)*(1.0+0.5*node)*uPixelRatio/-mv.z;
  gl_Position=projectionMatrix*mv;
}
`

/**
 * Energy trails: open wisps that leave the rim and dissolve into space. Each is
 * a camera-facing ribbon (gaussian falloff across its width, see
 * TRAIL_FRAGMENT): wide and bright at the root, thin and transparent at the
 * tip. Every trail lives its own cycle: it grows out, sways, fades, and is
 * reborn from another point of the rim; light runs along it. Roots stay off
 * the bottom of the sphere.
 * Per vertex: aT along the trail, aSide (-1/1 across), aRoot/aTangent (start
 * direction), aTrail = (id, violet, length, curvature), aShape = (lift, width).
 */
export const TRAIL_VERTEX = /* glsl */ `
${COMMON}
uniform float uIntensity;
attribute float aT;
attribute float aSide;
attribute vec3 aRoot;
attribute vec3 aTangent;
attribute vec4 aTrail;
attribute vec2 aShape;
varying float vSide;
varying float vAlpha;
varying vec3 vColor;
vec3 rotAxis(vec3 v,vec3 k,float a){ return v*cos(a)+cross(k,v)*sin(a)+k*dot(k,v)*(1.0-cos(a)); }
vec3 trailAt(float s,vec3 r0,vec3 tg,float curv,float lift,float id,float t){
  vec3 b=normalize(cross(r0,tg));
  float phi=s*curv;
  vec3 dir=normalize(r0*cos(phi)+tg*sin(phi));
  vec3 p=dir*(1.0+lift*pow(s,0.85)*uFluxReach);
  // slow organic sway, growing towards the tip
  p+=b*sin(s*2.2+t*0.6+id*6.28)*0.14*s;
  p+=tg*sin(s*1.3-t*0.45+id*3.1)*0.05*s;
  return p;
}
void main(){
  float t=uTime;
  float id=aTrail.x;
  // life cycle: grow, live, fade; each cycle starts from a new point of the rim
  float period=7.0+5.0*fract(id*3.7);
  float cyc=t/period+id*5.0;
  float k=floor(cyc);
  float f=fract(cyc);
  float h1=fract(sin((k+1.0)*12.9898+id*78.233)*43758.5453);
  float h2=fract(sin((k+1.0)*39.3468+id*11.135)*24634.6345);
  vec3 axis=normalize(vec3(h1-0.5,1.0,h2-0.5));
  float ang=(h1*2.0-1.0)*1.8;
  vec3 r0=normalize(rotAxis(aRoot,axis,ang));
  vec3 tg=rotAxis(aTangent,axis,ang);
  if(r0.y<-0.3){ r0.y=-r0.y; tg.y=-tg.y; }
  tg=normalize(tg-r0*dot(tg,r0));
  float L=aTrail.z*mix(1.0,uFluxReach,0.8);
  float len=L*smoothstep(0.0,0.35,f);
  float fade=1.0-smoothstep(0.72,1.0,f);
  float s=aT*L;
  vec3 p=trailAt(s,r0,tg,aTrail.w,aShape.x,id,t);
  vec3 p2=trailAt(s+0.03,r0,tg,aTrail.w,aShape.x,id,t);
  float breathe=1.0+0.5*(surfaceScale(normalize(p))-1.0)+uImpulse*0.08;
  p*=breathe;
  p2*=breathe;
  vec4 mv=modelViewMatrix*vec4(p,1.0);
  vec4 mv2=modelViewMatrix*vec4(p2,1.0);
  vec2 dir=mv2.xy-mv.xy;
  dir=length(dir)>1e-5?normalize(dir):vec2(1.0,0.0);
  float scale=length(modelViewMatrix[0].xyz);
  // ribbon: wide at the root, narrow at the tip
  mv.xy+=vec2(-dir.y,dir.x)*aSide*aShape.y*(1.0-0.7*aT)*scale/sqrt(uFluxReach);
  vSide=aSide;
  float grown=1.0-smoothstep(len-0.3*L,len,s);
  float root=smoothstep(0.0,0.05,aT);
  float along=pow(1.0-aT,1.4);
  float pulse=exp(-fract(aT*1.4-uFlowTime*0.3-id)*5.0);
  vec3 centre=(modelViewMatrix*vec4(0.0,0.0,0.0,1.0)).xyz;
  float radial=length(mv.xy-centre.xy)/max(scale,1e-4);
  float outside=mix(0.1,1.0,smoothstep(0.95,1.12,radial));
  float flicker=mix(1.0,step(0.35,fract(sin(dot(vec2(id,floor(t*6.0)),vec2(12.9,78.2)))*43758.5)),uJitter);
  float zone=violetZone(r0)*uPurple;
  vec3 c=mix(vec3(0.16,0.45,1.0),CYAN,clamp(0.3*pulse+0.35*(1.0-aT),0.0,1.0));
  c=mix(c,mix(INDIGO,VIOLET,0.6),clamp(aTrail.y*0.55+zone*(1.0-aT)*0.6,0.0,0.75));
  vColor=warmShift(c);
  vAlpha=uIntensity*1.6*grown*root*fade*flicker*outside*frontOf(p)*(0.25+0.75*along)*(0.7+0.6*pulse);
  gl_Position=projectionMatrix*mv;
}
`

/** Soft ribbon profile: a thin bright core inside a wide gaussian glow. */
export const TRAIL_FRAGMENT = /* glsl */ `
varying float vSide;
varying float vAlpha;
varying vec3 vColor;
${GRADE}
void main(){
  float v=vSide;
  float light=exp(-v*v*28.0)+exp(-v*v*3.0)*0.35;
  // never negative: in additive blending that would darken (black notches)
  gl_FragColor=vec4(max(grade(vColor),0.0)*light*clamp(vAlpha,0.0,2.0),1.0);
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

/**
 * Soft cyan bloom around the rim, violet glow where the violet zones meet the
 * rim, faint outer haze. No white: the response wave is a cyan ring only.
 */
export const GLOW_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uPurple;
uniform float uWave;
uniform float uWarm;
uniform float uRhythm;
uniform float uGlow;
uniform float uRim;
uniform float uFill;
uniform float uMorph;
uniform float uAfterglow;
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
  vec2 n=vUv/max(length(vUv),1e-4);
  vec3 q=vec3(mat2(0.8,0.6,-0.6,0.8)*n*1.3+vec2(3.7,1.3),uTime*0.1);
  float irregular=0.6+0.55*smoothstep(-0.5,0.7,snoise(q));
  float zone=smoothstep(-0.2,0.8,snoise(q*1.2+vec3(9.0,0.0,uTime*0.05))*0.7+snoise(q*2.7+vec3(1.0,uTime*0.06,4.0))*0.45)*uPurple;
  float bt=0.5+0.5*sin(uTime*4.2);
  float pulse=1.0+uRhythm*0.3*bt*bt;
  float e1=(d-0.995)*34.0, e2=(d-1.0)*5.0;
  float ring=exp(-e1*e1)*0.85*irregular+exp(-e2*e2)*0.24*irregular;
  float haze=d>1.0?exp(-(d-1.0)*3.0)*0.055:0.015+0.03*smoothstep(0.7,1.0,d);
  float edge=smoothstep(2.0,1.45,d);
  float lf=smoothstep(0.0,1.0,d);
  float light=0.6+0.55*clamp(dot(n,normalize(vec2(-0.55,-0.8))),-1.0,1.0);
  float fill=d<1.0?(0.12+0.5*lf*lf)*light*smoothstep(1.0,0.97,d):0.0;
  float fw=(d-uWave*1.1)*6.0;
  float wave=uWave<0.0?0.0:exp(-fw*fw)*(1.0-uWave)*0.35;
  // In the violet zones the rim light turns violet (replaces cyan, never adds to it).
  float vz=clamp(zone*(0.25+0.3*uAfterglow),0.0,0.35);
  // violet only on the thin rim line; the wide halo stays cyan (no violet sectors)
  float thin=exp(-e1*e1)*0.85*irregular*uRim, wide=exp(-e2*e2)*0.24*irregular*mix(0.35,1.0,uRim);
  vec3 c=mix(vec3(0.22,0.7,1.0),vec3(0.55,0.22,1.0),vz)*thin*(1.0+0.4*vz)
    +vec3(0.22,0.7,1.0)*wide*(1.0-0.4*vz)
    +vec3(0.08,0.26,0.9)*haze
    +vec3(0.06,0.5,1.0)*fill*uFill
    +vec3(0.15,0.55,1.0)*wave;
  gl_FragColor=vec4(grade(warmShift(c))*uGlow*pulse*edge*(1.0-0.85*uMorph),1.0);
}
`
