import { useEffect, useRef } from 'react';

// A dark orange-black mist: domain-warped fbm, no grain. Rendered at half resolution, which the
// mist is soft enough to hide completely.
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
  float t = u_time * 0.022;
  vec2 m = (u_mouse - 0.5) * vec2(0.25, 0.18);

  // Two rounds of domain warping at low frequency: broad, slow, folding mist
  vec2 q = vec2(fbm(p * 0.8 + t + m), fbm(p * 0.8 - t * 1.1 + vec2(4.7, 1.3)));
  vec2 r = vec2(
    fbm(p * 1.0 + 1.7 * q + vec2(1.7, 9.2) + t * 0.5),
    fbm(p * 1.0 + 1.7 * q + vec2(8.3, 2.8) - t * 0.4)
  );
  // The warped fbm only spans roughly 0.22 to 0.56; stretch that to 0..1 density
  float n = smoothstep(0.22, 0.54, fbm(p * 0.9 + 1.8 * r));

  // Near-black where the mist thins, dark Monero orange where it gathers
  vec3 col = mix(vec3(0.018, 0.014, 0.012), vec3(0.25, 0.095, 0.014), pow(n, 1.5));
  // A warmer glow in the thickest folds
  float glow = smoothstep(0.55, 1.0, n * (0.85 + 0.3 * smoothstep(0.3, 0.5, r.x)));
  col += vec3(0.62, 0.25, 0.04) * glow * glow * 0.5;
  // Soft light from the top right and an ember low on the left
  col += vec3(0.12, 0.05, 0.012) * smoothstep(1.25, 0.0, length(uv - vec2(0.72, 1.08)));
  col += vec3(0.07, 0.025, 0.004) * smoothstep(0.9, 0.0, length(uv - vec2(0.02, -0.06)));
  col *= smoothstep(2.1, 0.25, length(p * vec2(0.7, 1.0)));
  // A fixed dither below one 8-bit step: invisible, it only stops the dark gradients banding
  col += (hash(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0);
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}`;

const SCALE = 0.5;
// The smoke drifts slowly, so 24 frames a second looks the same as 60 and leaves the GPU
// free for the glass panels that blur it.
const FRAME_MS = 1000 / 24;
// While the page scrolls the field holds still, so scrolling gets the whole frame budget.
const SCROLL_REST_MS = 180;

// One clock for every instance, so the splash draws the exact frame the page background
// draws beneath it and the hand-off when the splash fades is invisible.
let sharedT0: number | null = null;

/** Moving mist for the page background, also drawn identically behind the first-visit splash. */
export const GrainField = ({ splash = false }: { splash?: boolean }) => {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const stillFrame = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const gl = el?.getContext('webgl', {
      antialias: false,
      alpha: false,
      depth: false,
      preserveDrawingBuffer: stillFrame,
    });
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
      if (stillFrame) draw(performance.now());
    };

    const target = { x: 0.5, y: 0.5 },
      mouse = { x: 0.5, y: 0.5 };
    const onMove = (e: PointerEvent) => {
      target.x = e.clientX / window.innerWidth;
      target.y = 1 - e.clientY / window.innerHeight;
    };
    sharedT0 ??= performance.now() - 40_000 * Math.random();
    const t0 = sharedT0;
    let raf = 0,
      last = 0,
      scrolledAt = 0;
    const onScroll = () => {
      scrolledAt = performance.now();
    };
    const draw = (now: number) => {
      mouse.x += (target.x - mouse.x) * 0.04;
      mouse.y += (target.y - mouse.y) * 0.04;
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || now - last < FRAME_MS || now - scrolledAt < SCROLL_REST_MS) return;
      last = now;
      draw(now);
    };
    resize();
    window.addEventListener('resize', resize);
    if (!stillFrame) {
      window.addEventListener('pointermove', onMove, { passive: true });
      // Scroll events do not bubble; capture catches every scrolling panel, not just the window
      document.addEventListener('scroll', onScroll, { passive: true, capture: true });
      raf = requestAnimationFrame(loop);
    }
    el.setAttribute('data-ready', '');

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('scroll', onScroll, { capture: true });
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [splash]);

  return (
    <div className={splash ? 'grain-field splash-mist' : 'grain-field'} aria-hidden>
      <canvas ref={canvas} />
    </div>
  );
};
