// Aurora: soft vertical curtains of light flowing across the top of its box.
// Dependency-free raw WebGL port of the React Bits "Aurora" background (no ogl needed).
// createAurora(canvas, opts) returns a destroy() function.
const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const FRAG = `
precision mediump float;
uniform vec2 uRes;uniform float uTime;uniform float uAmp;uniform float uBlend;
uniform vec3 uC0;uniform vec3 uC1;uniform vec3 uC2;
vec3 permute(vec3 x){return mod(((x*34.0)+1.0)*x,289.0);}
float snoise(vec2 v){
  const vec4 C=vec4(.211324865405187,.366025403784439,-.577350269189626,.024390243902439);
  vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.,0.):vec2(0.,1.);
  vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod(i,289.0);
  vec3 p=permute(permute(i.y+vec3(0.,i1.y,1.))+i.x+vec3(0.,i1.x,1.));
  vec3 m=max(.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.);
  m=m*m;m=m*m;
  vec3 x=2.*fract(p*C.www)-1.;vec3 h=abs(x)-.5;vec3 ox=floor(x+.5);vec3 a0=x-ox;
  m*=1.79284291400159-.85373472095314*(a0*a0+h*h);
  vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.*dot(m,g);
}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec3 ramp=uv.x<.5?mix(uC0,uC1,uv.x*2.):mix(uC1,uC2,(uv.x-.5)*2.);
  float h=snoise(vec2(uv.x*2.+uTime*.1,uTime*.25))*.5*uAmp;
  h=exp(h);
  h=(uv.y*2.-h+.2);
  float intensity=.6*h;
  float a=smoothstep(.2-uBlend*.5,.2+uBlend*.5,intensity);
  vec3 col=intensity*ramp;
  gl_FragColor=vec4(col*a,a);
}`;

const hex = (s) => { const n = parseInt(s.replace('#', ''), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

export function createAurora(canvas, { colorStops = ['#4c1d95', '#7c3aed', '#2563eb'], amplitude = 0.9, blend = 0.7, speed = 0.5 } = {}) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return () => {};
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return () => {};
  const pr = gl.createProgram();
  gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'a');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(pr, n);
  const uRes = U('uRes'), uTime = U('uTime');
  gl.uniform1f(U('uAmp'), amplitude); gl.uniform1f(U('uBlend'), blend);
  colorStops.slice(0, 3).forEach((c, i) => gl.uniform3fv(U(`uC${i}`), hex(c)));

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let t = reduced ? 4 : 0, last = 0, raf = 0, visible = true;
  const draw = () => { gl.uniform1f(uTime, t); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLES, 0, 3); };
  const resize = () => {
    // Low-res on purpose: the aurora is soft, and this keeps weak phones smooth.
    const dpr = Math.min(window.devicePixelRatio || 1, 1);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr * 0.6));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr * 0.6));
    gl.viewport(0, 0, canvas.width, canvas.height); gl.uniform2f(uRes, canvas.width, canvas.height); draw();
  };
  const frame = (now) => {
    raf = 0; if (!visible || document.hidden) return;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0; last = now; t += dt * speed; draw();
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!reduced && !raf && visible) { last = 0; raf = requestAnimationFrame(frame); } };
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start(); }); io.observe(canvas);
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  const vis = () => { if (!document.hidden) start(); }; document.addEventListener('visibilitychange', vis);
  resize(); start();
  return () => {
    cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); document.removeEventListener('visibilitychange', vis);
    const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
  };
}
