import maplibregl from 'maplibre-gl';
import { IsochronesLayer } from '$lib/map/IsochronesLayer';
import type { CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';

// ---------------------------------------------------------------------------
// NToAllLayer
//
// Subclass of IsochronesLayer with two changes:
//
// 1. Composite shader uses a flat colour instead of the plasma colormap,
//    and fades based on remaining travel budget (field.r).
//
// 2. Voronoi clipping: the composite shader receives a second texture
//    (u_best) containing the global maximum budget across ALL origins at
//    each pixel. A pixel is discarded if this layer's own budget is less
//    than the global best — meaning another origin reaches this location
//    faster. This eliminates overlap entirely.
//
// The u_best texture is managed externally by NToAll.svelte, which builds
// it after all layers have completed their prerender() passes.
// ---------------------------------------------------------------------------

const glslVec3 = (hex: string): string => {
	const value = Number.parseInt(hex.replace('#', '').slice(0, 6), 16);
	const r = (((value >> 16) & 0xff) / 0xff).toFixed(4);
	const g = (((value >> 8) & 0xff) / 0xff).toFixed(4);
	const b = ((value & 0xff) / 0xff).toFixed(4);
	return `vec3(${r},${g},${b})`;
};

const makeCompositeFragmentShader = (color: string) => `#version 300 es
precision mediump float;
uniform sampler2D u_texture;  // this layer's union field (RG8: budget, coverage)
uniform sampler2D u_best;     // global max budget across all layers (R16F)
uniform float u_opacity;
uniform bool u_voronoi;
in vec2 v_uv;
out vec4 fragColor;

void main() {
	vec2 field    = texture(u_texture, v_uv).rg;
	float budget   = field.r;   // remaining budget: 1=just departed, 0=rim
	float coverage = field.g;   // antialiased disc mask

	if (coverage <= 0.0) discard;

	if (u_voronoi) {
		float best = texture(u_best, v_uv).r;
		// Discard if another origin has a strictly higher budget here.
		// Epsilon 0.01 prevents gaps at exact ties.
		if (budget < best - 0.001) discard;
	}

	// Fade: opaque at center (high budget = short travel time),
	// transparent at rim (budget exhausted). Same as plasma but flat colour.
	float a = coverage * budget * u_opacity;
	if (a <= 0.0) discard;

	fragColor = vec4(${glslVec3(color)} * a, a); // premultiplied alpha
}
`;

const COMPOSITE_VERTEX_SHADER = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
	v_uv = a_uv;
	gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Minimal pass-through shader that writes one layer's budget (R channel)
// into the best texture using MAX blending. Run once per layer.
const MERGE_FRAGMENT_SHADER = `#version 300 es
precision mediump float;
uniform sampler2D u_src;
in vec2 v_uv;
out vec4 fragColor;
void main() {
	float budget = texture(u_src, v_uv).r;
	fragColor = vec4(budget, 0.0, 0.0, 1.0);
}
`;

const compile = (gl: WebGL2RenderingContext, type: number, src: string) => {
	const s = gl.createShader(type)!;
	gl.shaderSource(s, src);
	gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
		console.error('[NToAllLayer] shader error', gl.getShaderInfoLog(s));
		gl.deleteShader(s);
		return null;
	}
	return s;
};

const link = (gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader) => {
	const p = gl.createProgram()!;
	gl.attachShader(p, vs);
	gl.attachShader(p, fs);
	gl.linkProgram(p);
	gl.deleteShader(vs);
	gl.deleteShader(fs);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		console.error('[NToAllLayer] link error', gl.getProgramInfoLog(p));
		gl.deleteProgram(p);
		return null;
	}
	return p;
};

export class NToAllLayer extends IsochronesLayer {
	private readonly color: string;

	// Set by NToAll.svelte after building the best texture.
	private bestTexture: WebGLTexture | null = null;
	private voronoi = true;

	// Extra uniform locations on the patched composite program.
	private bestLoc:    WebGLUniformLocation | null = null;
	private voronoiLoc: WebGLUniformLocation | null = null;

	// Exposes the internal union texture so NToAll.svelte can MAX-blend it
	// into the shared best texture.
	getUnionTexture(): WebGLTexture | null {
		return (this as unknown as Record<string, unknown>)['texture'] as WebGLTexture | null;
	}

	constructor(id: string, color: string) {
		super(id);
		this.color = color;
	}

	setBestTexture(t: WebGLTexture | null) {
		this.bestTexture = t;
	}

	setVoronoi(v: boolean) {
		this.voronoi = v;
	}

	override onAdd(map: MapLibreMap, rawGl: WebGL2RenderingContext | WebGLRenderingContext): void {
		const gl = rawGl as WebGL2RenderingContext;
		super.onAdd(map, gl);
		this.patchCompositeProgram(gl);
	}

	private patchCompositeProgram(gl: WebGL2RenderingContext) {
		const vs = compile(gl, gl.VERTEX_SHADER, COMPOSITE_VERTEX_SHADER);
		const fs = compile(gl, gl.FRAGMENT_SHADER, makeCompositeFragmentShader(this.color));
		if (!vs || !fs) return;
		const prog = link(gl, vs, fs);
		if (!prog) return;

		const self = this as unknown as Record<string, unknown>;
		self['compositeProgram'] = prog;
		self['textureLocation']  = gl.getUniformLocation(prog, 'u_texture');
		self['opacityLocation']  = gl.getUniformLocation(prog, 'u_opacity');
		this.bestLoc    = gl.getUniformLocation(prog, 'u_best');
		this.voronoiLoc = gl.getUniformLocation(prog, 'u_voronoi');
	}

	override render(rawGl: WebGL2RenderingContext | WebGLRenderingContext, options: CustomRenderMethodInput): void {
		const gl = rawGl as WebGL2RenderingContext;
		// Bind best texture to unit 1 before parent renders.
		if (this.bestTexture) {
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, this.bestTexture);
			gl.activeTexture(gl.TEXTURE0);
		}

		super.render(gl, options);

		// After parent has bound its composite program, set extra uniforms.
		const prog = (this as unknown as Record<string, unknown>)['compositeProgram'] as WebGLProgram | null;
		if (prog) {
			gl.useProgram(prog);
			if (this.bestLoc)    gl.uniform1i(this.bestLoc, 1);
			if (this.voronoiLoc) gl.uniform1i(this.voronoiLoc, this.voronoi ? 1 : 0);
		}

		if (this.bestTexture) {
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, null);
			gl.activeTexture(gl.TEXTURE0);
		}
	}
}

// ---------------------------------------------------------------------------
// NToAllBestLayer
//
// A standalone custom layer that runs after all NToAllLayer prerender() calls
// and builds the shared "best budget" texture by MAX-blending all union
// textures. NToAll.svelte adds this layer AFTER the NToAllLayers so MapLibre
// calls its prerender() last — after all union textures are populated.
// ---------------------------------------------------------------------------
const QUAD = new Float32Array([-1,-1,0,0, 1,-1,1,0, -1,1,0,1, 1,1,1,1]);

export class NToAllBestLayer implements maplibregl.CustomLayerInterface {
	readonly id = 'n-to-all-best';
	readonly type = 'custom' as const;
	readonly renderingMode = '2d' as const;

	private layers: NToAllLayer[] = [];
	private gl: WebGL2RenderingContext | null = null;

	// The shared best texture — passed to each NToAllLayer.setBestTexture().
	private bestTexture: WebGLTexture | null = null;
	private bestFb: WebGLFramebuffer | null = null;
	private mergeProgram: WebGLProgram | null = null;
	private mergeVao: WebGLVertexArrayObject | null = null;
	private quadBuffer: WebGLBuffer | null = null;
	private srcLoc: WebGLUniformLocation | null = null;
	private w = 0;
	private h = 0;

	setLayers(layers: NToAllLayer[]) {
		this.layers = layers;
	}

	onAdd(_map: maplibregl.Map, rawGl: WebGL2RenderingContext | WebGLRenderingContext) {
		const gl = rawGl as WebGL2RenderingContext;
		// R16F framebuffer requires this extension in WebGL2.
		gl.getExtension("EXT_color_buffer_float");
		this.gl = gl;

		const vs = compile(gl, gl.VERTEX_SHADER, COMPOSITE_VERTEX_SHADER);
		const fs = compile(gl, gl.FRAGMENT_SHADER, MERGE_FRAGMENT_SHADER);
		if (!vs || !fs) return;
		this.mergeProgram = link(gl, vs, fs);
		if (!this.mergeProgram) return;

		this.srcLoc = gl.getUniformLocation(this.mergeProgram, 'u_src');

		this.quadBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

		this.mergeVao = gl.createVertexArray();
		gl.bindVertexArray(this.mergeVao);
		const posLoc = gl.getAttribLocation(this.mergeProgram, 'a_pos');
		const uvLoc  = gl.getAttribLocation(this.mergeProgram, 'a_uv');
		gl.enableVertexAttribArray(posLoc);
		gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
		gl.enableVertexAttribArray(uvLoc);
		gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
		gl.bindVertexArray(null);
		gl.bindBuffer(gl.ARRAY_BUFFER, null);
	}

	onRemove(_map: maplibregl.Map, rawGl: WebGL2RenderingContext | WebGLRenderingContext) {
		const gl = rawGl as WebGL2RenderingContext;
		if (this.mergeProgram) { gl.deleteProgram(this.mergeProgram); this.mergeProgram = null; }
		if (this.quadBuffer)   { gl.deleteBuffer(this.quadBuffer);   this.quadBuffer = null; }
		if (this.mergeVao)     { gl.deleteVertexArray(this.mergeVao); this.mergeVao = null; }
		if (this.bestFb)       { gl.deleteFramebuffer(this.bestFb);   this.bestFb = null; }
		if (this.bestTexture)  { gl.deleteTexture(this.bestTexture);  this.bestTexture = null; }
		this.gl = null;
	}

	prerender(rawGl: WebGL2RenderingContext | WebGLRenderingContext, _options: CustomRenderMethodInput) {
		const gl = rawGl as WebGL2RenderingContext;
		if (!this.mergeProgram || !this.mergeVao || this.layers.length === 0) return;

		const w = gl.drawingBufferWidth;
		const h = gl.drawingBufferHeight;

		// (Re-)allocate best texture if size changed.
		if (!this.bestTexture || this.w !== w || this.h !== h) {
			if (this.bestTexture) gl.deleteTexture(this.bestTexture);
			if (this.bestFb)      gl.deleteFramebuffer(this.bestFb);

			this.bestTexture = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, this.bestTexture);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			// R16F: higher precision prevents quantisation ties at boundaries.
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, null);
			gl.bindTexture(gl.TEXTURE_2D, null);

			this.bestFb = gl.createFramebuffer();
			const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.bestFb);
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bestTexture, 0);
			gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);

			this.w = w;
			this.h = h;

			// Distribute new texture to all layers.
			for (const layer of this.layers) {
				layer.setBestTexture(this.bestTexture);
				layer.setVoronoi(true);
			}
		}

		// Clear the best texture then MAX-blend each layer's union texture into it.
		const prevFb  = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
		const prevVp  = gl.getParameter(gl.VIEWPORT) as Int32Array;
		const depthOn = gl.isEnabled(gl.DEPTH_TEST);
		const stenOn  = gl.isEnabled(gl.STENCIL_TEST);
		gl.disable(gl.DEPTH_TEST);
		gl.disable(gl.STENCIL_TEST);

		gl.bindFramebuffer(gl.FRAMEBUFFER, this.bestFb);
		gl.viewport(0, 0, w, h);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.enable(gl.BLEND);
		gl.blendEquation(gl.MAX);

		gl.useProgram(this.mergeProgram);
		gl.bindVertexArray(this.mergeVao);

		for (const layer of this.layers) {
			const tex = layer.getUnionTexture();
			if (!tex) continue;
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, tex);
			gl.uniform1i(this.srcLoc, 0);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}

		gl.bindVertexArray(null);
		gl.blendEquation(gl.FUNC_ADD);
		gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
		gl.viewport(prevVp[0], prevVp[1], prevVp[2], prevVp[3]);
		if (depthOn) gl.enable(gl.DEPTH_TEST);
		if (stenOn)  gl.enable(gl.STENCIL_TEST);
	}

	// NToAllBestLayer never renders anything to the screen itself.
	render(_gl: WebGL2RenderingContext | WebGLRenderingContext, _options: CustomRenderMethodInput) {}
}
