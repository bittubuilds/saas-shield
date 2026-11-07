// Silk: flowing satin folds with a glossy highlight that leans toward the cursor and ripples on click.
// Dependency-free raw WebGL. createSilk(canvas, opts) returns a destroy() function.
const VERT = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
const FRAG = `
precision mediump float;
uniform vec2 uRes;uniform float uTime;uniform vec3 uColor;uniform vec2 uMouse;uniform vec3 uRip[4];
float fold(vec2 p){
  float t=uTime*.18;
  p=mat2(.8,.6,-.6,.8)*p;
  float a=sin(p.x*2.6+sin(p.y*1.5+t*1.3)*1.6+t);
  float b=sin(p.x*5.4-p.y*1.1+t*1.7+sin(p.y*2.7-t)*.9)*.45;
  return a+b;
}
void main(){
  float asp=uRes.x/uRes.y;
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 p=(uv-.5)*vec2(asp,1.)*2.;
  vec2 m=(uMouse-.5)*vec2(asp,1.)*2.;
  vec2 d=p-m;
  p+=d*.3*exp(-dot(d,d)*2.2);
  float ring=0.;
  for(int i=0;i<4;i++){
    vec3 q=uRip[i];float age=uTime-q.z;
    if(age>0.&&age<3.5){
      vec2 c=(q.xy-.5)*vec2(asp,1.)*2.;
      vec2 dd=p-c;float rr=length(dd)+1e-4;
      float front=age*.8;
      float w=sin((rr-front)*16.)*exp(-abs(rr-front)*4.)*(1.-age/3.5);
      p+=dd/rr*w*.07;ring+=w;
    }
  }
  float e=.012;
  float h=fold(p);
  vec2 g=vec2(fold(p+vec2(e,0.))-h,fold(p+vec2(0.,e))-h)/e;
  vec3 n=normalize(vec3(-g*.16,1.));
  vec3 L=normalize(vec3(-.35+m.x*.25,.55+m.y*.25,.75));
  float diff=max(dot(n,L),0.);
  float spec=pow(max(dot(reflect(-L,n),vec3(0.,0.,1.)),0.),24.);
  float band=smoothstep(-.6,1.4,h);
  vec3 tint=mix(uColor,vec3(.62,.1,.95),smoothstep(.2,1.,band)*.7);
  vec3 col=tint*pow(band,2.)*(.25+1.1*diff*diff);
  col+=vec3(.7,.6,1.)*spec*.35*band;
  col+=tint*abs(ring)*.18;
  col*=1.-dot(uv-.5,uv-.5);
  gl_FragColor=vec4(pow(col,vec3(.9)),1.);
}`;

export function createSilk(canvas, { color = '#5227ff', speed = 1, interactive = true } = {}) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
  if (!gl) return () => {};
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return () => {};
  const pr = gl.createProgram();
  gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'a');
  gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(pr, n);
  const uRes = U('uRes'), uTime = U('uTime'), uMouse = U('uMouse'), uRip = U('uRip[0]');
  const n = parseInt(color.replace('#', ''), 16);
  gl.uniform3f(U('uColor'), ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rips = new Float32Array(12).fill(-100); // x, y, startTime per ripple
  let ripIdx = 0, t = reduced ? 8 : 0, last = 0, raf = 0, visible = true;
  const target = { x: 0.5, y: 0.5 }, cur = { x: 0.5, y: 0.5 };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    draw();
  };
  const draw = () => {
    gl.uniform1f(uTime, t);
    gl.uniform2f(uMouse, cur.x, cur.y);
    gl.uniform3fv(uRip, rips);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const frame = (now) => {
    raf = 0;
    if (!visible) return;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now; t += dt * speed;
    cur.x += (target.x - cur.x) * 0.06; cur.y += (target.y - cur.y) * 0.06;
    draw();
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!reduced && !raf && visible) { last = 0; raf = requestAnimationFrame(frame); } };

  const toLocal = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  };
  const onMove = (e) => { const p = toLocal(e); if (p) { target.x = p.x; target.y = p.y; } };
  const onDown = (e) => {
    if (e.target.closest && e.target.closest('input,button,a,label')) return;
    const p = toLocal(e); if (!p) return;
    rips[ripIdx * 3] = p.x; rips[ripIdx * 3 + 1] = p.y; rips[ripIdx * 3 + 2] = t;
    ripIdx = (ripIdx + 1) % 4;
  };
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) start(); });
  io.observe(canvas);
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  if (interactive && !reduced) {
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
  }
  resize(); start();
  return () => {
    cancelAnimationFrame(raf); io.disconnect(); ro.disconnect();
    window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerdown', onDown);
    const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext();
  };
}
