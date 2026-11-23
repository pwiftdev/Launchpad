import { useEffect, useRef } from 'react';

// Domain-warped fbm smoke in Monero orange over near-black, plus per-frame film
// grain. Rendered at half resolution on purpose: the upscale makes the grain chunky and filmic.
const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform vec2 u_mouse;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p = r * p * 2.03 + 3.1;
    a *= 0.5;
  }
  return v;
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_res.y;
  float t = u_time * 0.04;
  vec2 m = (u_mouse - 0.5) * vec2(0.35, 0.25);

  vec2 q = vec2(fbm(p * 1.3 + t + m), fbm(p * 1.3 - t * 1.25 + vec2(4.7, 1.3)));
  vec2 r = vec2(
    fbm(p * 1.7 + 2.3 * q + vec2(1.7, 9.2) + t * 0.6),
    fbm(p * 1.7 + 2.3 * q + vec2(8.3, 2.8) - t * 0.45)
  );
  float f = fbm(p * 1.5 + 2.4 * r);

  // near-black with a violet cast
  vec3 col = vec3(0.012, 0.010, 0.010);
  // purple smoke
  col = mix(col, vec3(0.36, 0.13, 0.0), smoothstep(0.28, 0.95, f));
  // deeper indigo pooling in the folds
  col += vec3(0.07, 0.025, 0.0) * smoothstep(0.45, 1.0, r.y);
  // lilac-magenta highlights where the smoke thickens
  float lift = smoothstep(0.62, 0.98, f * (0.6 + r.x));
  col += vec3(1.0, 0.40, 0.0) * lift * lift * 0.6;
  // one soft light from above, heavy vignette
  col += vec3(0.045, 0.02, 0.0) * smoothstep(1.1, 0.0, length(uv - vec2(0.62, 1.12)));
  col *= smoothstep(1.6, 0.15, length(p * vec2(0.8, 1.1)));
  // film grain, new every frame
  float g = hash(gl_FragCoord.xy + fract(u_time * 7.13) * vec2(91.7, 37.3));
  // mostly multiplicative so the grain keeps the purple instead of graying it
  col *= 0.72 + g * 0.56;
  col += (g - 0.5) * 0.035;
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}`;

const SCALE = 0.5;
const FRAME_MS = 1000 / 30;

/** Full-viewport animated background, fixed behind every page. CSS fallback without WebGL. */
export const GrainField = () => {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const gl = el?.getContext('webgl', { antialias: false, alpha: false, depth: false });
    if (!el || !gl) {
      el?.setAttribute('data-fallback', '');
      return;
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT),
      fs = compile(gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!vs || !fs || !program) {
      el.setAttribute('data-fallback', '');
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      el.setAttribute('data-fallback', '');
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(program, 'u_res'),
      uTime = gl.getUniformLocation(program, 'u_time'),
      uMouse = gl.getUniformLocation(program, 'u_mouse');

    const resize = () => {
      const w = Math.max(1, Math.round(window.innerWidth * SCALE)),
        h = Math.max(1, Math.round(window.innerHeight * SCALE));
      if (el.width !== w || el.height !== h) {
        el.width = w;
        el.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
    };
    resize();
    window.addEventListener('resize', resize);

    const target = { x: 0.5, y: 0.5 },
      mouse = { x: 0.5, y: 0.5 };
    const onMove = (e: PointerEvent) => {
      target.x = e.clientX / window.innerWidth;
      target.y = 1 - e.clientY / window.innerHeight;
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now() - 40_000 * Math.random();
    let raf = 0,
      last = 0;
    const draw = (now: number) => {
      mouse.x += (target.x - mouse.x) * 0.04;
      mouse.y += (target.y - mouse.y) * 0.04;
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || now - last < FRAME_MS) return;
      last = now;
      draw(now);
    };
    if (reduced) draw(performance.now());
    else raf = requestAnimationFrame(loop);
    el.setAttribute('data-ready', '');

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, []);

  return (
    <div className="grain-field" aria-hidden>
      <canvas ref={canvas} />
    </div>
  );
};
