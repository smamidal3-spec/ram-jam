import { Renderer, Program, Mesh, Color, Triangle } from 'https://unpkg.com/ogl';

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;

varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position, 0, 1);
}
`;

const fragmentShader = `
precision highp float;

uniform float uTime;
uniform vec3 uColor;
uniform vec3 uResolution;
uniform vec2 uMouse;
uniform float uAmplitude;
uniform float uSpeed;

varying vec2 vUv;

void main() {
  float mr = min(uResolution.x, uResolution.y);
  vec2 uv = (vUv.xy * 2.0 - 1.0) * uResolution.xy / mr;

  uv += (uMouse - vec2(0.5)) * uAmplitude;

  float d = -uTime * 0.5 * uSpeed;
  float a = 0.0;
  for (float i = 0.0; i < 8.0; ++i) {
    a += cos(i - d - a * uv.x);
    d += sin(uv.y * i + a);
  }
  d += uTime * 0.5 * uSpeed;
  vec3 col = vec3(cos(uv * vec2(d, a)) * 0.6 + 0.4, cos(a + d) * 0.5 + 0.5);
  col = cos(col * cos(vec3(d, a, 2.5)) * 0.5 + 0.5) * uColor;
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Iridescence {
  constructor(container, options = {}) {
    this.ctn = container;
    this.color = options.color || [1, 1, 1];
    this.speed = options.speed || 1.0;
    this.amplitude = options.amplitude || 0.1;
    this.mouseReact = options.mouseReact !== undefined ? options.mouseReact : true;
    this.mousePos = { x: 0.5, y: 0.5 };

    this.init();
  }

  init() {
    try {
      this.renderer = new Renderer();
      this.gl = this.renderer.gl;
      this.gl.clearColor(0, 0, 0, 0);

      this.geometry = new Triangle(this.gl);
      this.program = new Program(this.gl, {
        vertex: vertexShader,
        fragment: fragmentShader,
        uniforms: {
          uTime: { value: 0 },
          uColor: { value: new Color(...this.color) },
          uResolution: {
            value: new Color(this.gl.canvas.width, this.gl.canvas.height, this.gl.canvas.width / this.gl.canvas.height)
          },
          uMouse: { value: new Float32Array([this.mousePos.x, this.mousePos.y]) },
          uAmplitude: { value: this.amplitude },
          uSpeed: { value: this.speed }
        }
      });

      this.mesh = new Mesh(this.gl, { geometry: this.geometry, program: this.program });
      this.ctn.appendChild(this.gl.canvas);

      this.resize();
      this.resizeHandler = () => this.resize();
      window.addEventListener('resize', this.resizeHandler, false);

      if (this.mouseReact) {
        this.mouseMoveHandler = (e) => this.handleMouseMove(e);
        window.addEventListener('mousemove', this.mouseMoveHandler);
      }

      this.animate();
    } catch (e) {
      console.error('Iridescence init failed:', e);
      // Fallback: simple CSS gradient or just transparent background
      if (this.ctn) {
        this.ctn.style.background = 'linear-gradient(45deg, #03050a, #0e2a5c)';
      }
    }
  }

  resize() {
    if (!this.ctn) return;
    const scale = 1;
    this.renderer.setSize(this.ctn.offsetWidth * scale, this.ctn.offsetHeight * scale);
    if (this.program) {
      this.program.uniforms.uResolution.value = new Color(
        this.gl.canvas.width,
        this.gl.canvas.height,
        this.gl.canvas.width / this.gl.canvas.height
      );
    }
  }

  handleMouseMove(e) {
    if (!this.ctn) return;
    const rect = this.ctn.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1.0 - (e.clientY - rect.top) / rect.height;
    this.mousePos = { x, y };
    if (this.program) {
      this.program.uniforms.uMouse.value[0] = x;
      this.program.uniforms.uMouse.value[1] = y;
    }
  }

  animate(t) {
    this.animateId = requestAnimationFrame((t) => this.animate(t));
    if (this.program) {
      this.program.uniforms.uTime.value = t * 0.001;
    }
    this.renderer.render({ scene: this.mesh });
  }

  destroy() {
    cancelAnimationFrame(this.animateId);
    window.removeEventListener('resize', this.resizeHandler);
    if (this.mouseReact) {
      window.removeEventListener('mousemove', this.mouseMoveHandler);
    }
    if (this.ctn && this.gl.canvas.parentNode === this.ctn) {
      this.ctn.removeChild(this.gl.canvas);
    }
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
