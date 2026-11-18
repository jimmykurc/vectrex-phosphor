/**
 * Phosphor renderer.
 *
 * WebGL2 pipeline:
 *   1. persistence: the phosphor buffer (half-float when available) is
 *      multiplied by a decay factor once per emulated frame
 *   2. beam: every segment becomes a quad whose fragment shader evaluates a
 *      gaussian distance-to-segment falloff, added with additive blending
 *   3. bloom: two separable gaussian blurs at 1/2 and 1/4 resolution
 *   4. composite: tone mapping, beam and glow tint, tube vignette
 *
 * Falls back to Canvas 2D when WebGL2 is not available.
 */

import { SCREEN_W, SCREEN_H, VectorGenerator } from '../hw/vector.js';

const F = VectorGenerator.FIELDS;
export const ASPECT = SCREEN_W / SCREEN_H;

const VS_LINE = `#version 300 es
in vec2 a_pos;
in vec2 a_local;
in float a_len;
in float a_bright;
uniform vec2 u_res;
out vec2 v_local;
out float v_len;
out float v_bright;
void main() {
  v_local = a_local; v_len = a_len; v_bright = a_bright;
  gl_Position = vec4(a_pos / u_res * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_LINE = `#version 300 es
precision highp float;
in vec2 v_local;
in float v_len;
in float v_bright;
uniform float u_k;
out vec4 o;
void main() {
  float ux = max(max(-v_local.x, v_local.x - v_len), 0.0);
  float d2 = ux * ux + v_local.y * v_local.y;
  o = vec4(vec3(v_bright * exp(-d2 * u_k)), 1.0);
}`;

const VS_FULL = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS_SOLID = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o;
void main() { o = u_color; }`;

const FS_BLUR = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_dir;
in vec2 v_uv;
out vec4 o;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb * 0.2270270;
  c += (texture(u_tex, v_uv + u_dir * 1.3846153).rgb + texture(u_tex, v_uv - u_dir * 1.3846153).rgb) * 0.3162162;
  c += (texture(u_tex, v_uv + u_dir * 3.2307692).rgb + texture(u_tex, v_uv - u_dir * 3.2307692).rgb) * 0.0702702;
  o = vec4(c, 1.0);
}`;

const FS_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D u_core;
uniform sampler2D u_glow1;
uniform sampler2D u_glow2;
uniform float u_glow;
in vec2 v_uv;
out vec4 o;
void main() {
  float c = texture(u_core, v_uv).r;
  float g1 = texture(u_glow1, v_uv).r;
  float g2 = texture(u_glow2, v_uv).r;
  vec3 beam = vec3(0.80, 0.92, 1.0);
  vec3 halo = vec3(0.28, 0.60, 1.0);
  vec3 col = beam * (1.0 - exp(-c * 1.7));
  col += halo * (g1 * 1.1 + g2 * 0.9) * u_glow;
  col += vec3(1.0) * max(c - 1.4, 0.0) * 0.2;
  vec2 q = v_uv - 0.5;
  float vig = clamp(1.0 - dot(q, q) * 1.1, 0.0, 1.0);
  col = col * (0.75 + 0.25 * vig) + vec3(0.008, 0.011, 0.016) * vig;
  // tiny ordered noise to avoid banding in the glow
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  o = vec4(col + (n - 0.5) / 255.0, 1.0);
}`;

function compile(gl, vs, fs) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const uniforms = {};
  const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(prog, i).name;
    uniforms[name] = gl.getUniformLocation(prog, name);
  }
  return { prog, u: uniforms };
}

/** Beam brightness for a segment: lines by intensity and speed, dots by dwell time. */
function brightness(z, dwell, lenUnits) {
  const zf = Math.min(z, 127) / 127;
  if (lenUnits < 1) return zf * Math.min(1.6, 0.6 + dwell / 10);
  const speed = lenUnits / Math.max(dwell, 1);
  return zf * Math.min(1.35, Math.max(0.7, Math.sqrt(70 / speed)));
}

class GLRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    this.canvas = canvas;
    this.float = !!gl.getExtension('EXT_color_buffer_float');
    this.persistence = 0.3;
    this.glow = 1.0;
    this.line = compile(gl, VS_LINE, FS_LINE);
    this.solid = compile(gl, VS_FULL, FS_SOLID);
    this.blur = compile(gl, VS_FULL, FS_BLUR);
    this.comp = compile(gl, VS_FULL, FS_COMPOSITE);
    this.vao = gl.createVertexArray();
    this.emptyVao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.verts = new Float32Array(6 * 6 * 4096);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const attr = (name, size, offset) => {
      const loc = gl.getAttribLocation(this.line.prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 24, offset);
    };
    attr('a_pos', 2, 0); attr('a_local', 2, 8); attr('a_len', 1, 16); attr('a_bright', 1, 20);
    gl.bindVertexArray(null);
    this.targets = null;
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      if (this.float) { this.float = false; gl.deleteFramebuffer(fb); gl.deleteTexture(tex); return this.makeTarget(w, h); }
      throw new Error('framebuffer incomplete');
    }
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fb, w, h };
  }

  resize(w, h) {
    const gl = this.gl;
    if (this.targets) for (const t of Object.values(this.targets)) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.targets = {
      phos: this.makeTarget(w, h),
      a: this.makeTarget(hw, hh), b: this.makeTarget(hw, hh),
      c: this.makeTarget(qw, qh), d: this.makeTarget(qw, qh),
    };
    this.w = w; this.h = h;
  }

  addFrame(segments, count) {
    const gl = this.gl, { w, h } = this, phos = this.targets.phos;
    gl.bindFramebuffer(gl.FRAMEBUFFER, phos.fb);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.BLEND);

    // Persistence: multiply the buffer by the decay factor.
    gl.useProgram(this.solid.prog);
    gl.bindVertexArray(this.emptyVao);
    if (this.float) {
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
      gl.uniform4f(this.solid.u.u_color, 0, 0, 0, this.persistence);
    } else {
      // 8-bit buffer: dst * decay - epsilon, so faint trails reach true black
      gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
      gl.blendFunc(gl.ONE, gl.SRC_ALPHA);
      gl.uniform4f(this.solid.u.u_color, 2 / 255, 2 / 255, 2 / 255, this.persistence);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Beam segments, additive
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.line.prog);
    const sigma = Math.max(0.75, w / 620);
    const R = sigma * 3;
    gl.uniform2f(this.line.u.u_res, w, h);
    gl.uniform1f(this.line.u.u_k, 1 / (2 * sigma * sigma));
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const sx = w / SCREEN_W, sy = h / SCREEN_H;
    const maxBatch = this.verts.length / 36;
    for (let start = 0; start < count; start += maxBatch) {
      const n = Math.min(maxBatch, count - start);
      const v = this.verts;
      let o = 0;
      for (let k = 0; k < n; k++) {
        const i = (start + k) * F;
        const x0 = (segments[i] + SCREEN_W / 2) * sx, y0 = (segments[i + 1] + SCREEN_H / 2) * sy;
        const x1 = (segments[i + 2] + SCREEN_W / 2) * sx, y1 = (segments[i + 3] + SCREEN_H / 2) * sy;
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.hypot(dx, dy);
        const units = Math.hypot(segments[i + 2] - segments[i], segments[i + 3] - segments[i + 1]);
        const b = brightness(segments[i + 4], segments[i + 5], units);
        let ux = 1, uy = 0;
        if (len > 1e-4) { ux = dx / len; uy = dy / len; }
        const nx = -uy, ny = ux;
        // corners: (along, across)
        const corners = [[-R, -R], [len + R, -R], [len + R, R], [-R, -R], [len + R, R], [-R, R]];
        for (const [a, c] of corners) {
          v[o++] = x0 + ux * a + nx * c; v[o++] = y0 + uy * a + ny * c;
          v[o++] = a; v[o++] = c; v[o++] = len; v[o++] = b;
        }
      }
      gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, o), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, n * 6);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  pass(prog, target, tex, setup) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
    gl.useProgram(prog.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (prog.u.u_tex) gl.uniform1i(prog.u.u_tex, 0);
    if (setup) setup();
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  present() {
    const gl = this.gl, t = this.targets;
    const blur = (dst, src, dx, dy, spread) => this.pass(this.blur, dst, src.tex, () =>
      gl.uniform2f(this.blur.u.u_dir, (dx * spread) / src.w, (dy * spread) / src.h));
    blur(t.a, t.phos, 1, 0, 2);
    blur(t.b, t.a, 0, 1, 1.5);
    blur(t.c, t.b, 1, 0, 2.5);
    blur(t.d, t.c, 0, 1, 2.5);
    this.pass(this.comp, null, t.phos.tex, () => {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, t.b.tex);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, t.d.tex);
      gl.uniform1i(this.comp.u.u_core, 0);
      gl.uniform1i(this.comp.u.u_glow1, 1);
      gl.uniform1i(this.comp.u.u_glow2, 2);
      gl.uniform1f(this.comp.u.u_glow, this.glow);
      gl.activeTexture(gl.TEXTURE0);
    });
  }

  clear() {
    const gl = this.gl;
    for (const t of Object.values(this.targets)) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }
}

class Canvas2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.persistence = 0.3;
    this.glow = 1;
  }
  resize(w, h) { this.w = w; this.h = h; this.clear(); }
  clear() { this.ctx.fillStyle = '#000'; this.ctx.fillRect(0, 0, this.w, this.h); }
  addFrame(segments, count) {
    const { ctx, w, h } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,${1 - this.persistence})`;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, w / 400);
    const sx = w / SCREEN_W, sy = h / SCREEN_H;
    for (let k = 0; k < count; k++) {
      const i = k * F;
      const units = Math.hypot(segments[i + 2] - segments[i], segments[i + 3] - segments[i + 1]);
      const b = Math.min(1, brightness(segments[i + 4], segments[i + 5], units));
      ctx.strokeStyle = `rgba(200,230,255,${b})`;
      ctx.beginPath();
      ctx.moveTo((segments[i] + SCREEN_W / 2) * sx, h - (segments[i + 1] + SCREEN_H / 2) * sy);
      ctx.lineTo((segments[i + 2] + SCREEN_W / 2) * sx + 0.01, h - (segments[i + 3] + SCREEN_H / 2) * sy);
      ctx.stroke();
    }
  }
  present() {}
}

/** Create the best available renderer for the canvas. */
export function createRenderer(canvas) {
  try {
    const r = new GLRenderer(canvas);
    r.kind = r.float ? 'WebGL2 (half-float)' : 'WebGL2';
    return r;
  } catch (e) {
    console.warn('WebGL2 renderer unavailable, using Canvas 2D:', e.message);
    let target = canvas;
    if (!canvas.getContext('2d')) { // a failed WebGL context still owns the canvas
      target = canvas.cloneNode();
      canvas.replaceWith(target);
    }
    const r = new Canvas2DRenderer(target);
    r.kind = 'Canvas 2D';
    return r;
  }
}
