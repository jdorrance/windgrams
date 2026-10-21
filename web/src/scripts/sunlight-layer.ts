// Sunlight colours drawn in the map's own WebGL pass, one texture per terrain
// tile. Panning reuses the textures; a new time of day repaints them.

import { MercatorCoordinate, type CustomRenderMethodInput, type Map as MapLibreMap } from "maplibre-gl";
import type { SolarTile } from "../lib/solar-tile.ts";
import { tileLngLatBounds } from "./map.ts";

export interface SunlightOverlayHost {
  minZoom: number;
  maxZoom: number;
  /** Changes when the colours must be repainted (the time slider moved). */
  revision(): number;
  /** Writes one tile's RGBA. Returns false when there is nothing to draw yet. */
  paint(tile: SolarTile, rgba: Uint8ClampedArray): boolean;
  load(coords: { x: number; y: number; z: number }): Promise<SolarTile | null>;
  /** The decoded tile, or null when it has not arrived yet. */
  peek(coords: { x: number; y: number; z: number }): SolarTile | null;
  inRange(coords: { x: number; y: number; z: number }): boolean;
}

const TILE = 256;
const VERTEX = `#version 300 es
uniform mat4 u_matrix;
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
  v_uv = a_uv;
}`;
const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec4 color = texture(u_tex, v_uv);
  if (color.a == 0.0) discard;
  float a = color.a * 0.8;
  fragColor = vec4(color.rgb * a, a);
}`;

function shader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

interface TextureEntry {
  texture: WebGLTexture;
  revision: number;
}

export class SunlightOverlay {
  readonly id = "sunlight";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;
  private readonly visible = new Set<string>();
  private readonly requested = new Set<string>();
  private readonly textures = new Map<string, TextureEntry>();
  private readonly pixels = new Uint8ClampedArray(TILE * TILE * 4);
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private matrixLocation: WebGLUniformLocation | null = null;
  private map: MapLibreMap | null = null;

  constructor(private readonly host: SunlightOverlayHost) {}

  visibleKeys() {
    return this.visible;
  }

  onAdd(map: MapLibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    this.initGl(gl);
    map.on("webglcontextlost", () => {
      this.textures.clear();
      this.program = null;
      this.buffer = null;
    });
  }

  onRemove(_map: MapLibreMap, gl: WebGL2RenderingContext) {
    for (const entry of this.textures.values()) gl.deleteTexture(entry.texture);
    this.textures.clear();
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    this.program = null;
    this.buffer = null;
    this.map = null;
  }

  render(gl: WebGL2RenderingContext, options: CustomRenderMethodInput) {
    const map = this.map;
    if (!map) return;
    if (!this.program) this.initGl(gl);
    const program = this.program;
    const buffer = this.buffer;
    if (!program || !buffer) return;

    const zoom = Math.max(this.host.minZoom, Math.min(this.host.maxZoom, Math.round(map.getZoom())));
    const bounds = map.getBounds();
    const n = 2 ** zoom;
    const x0 = Math.max(0, Math.floor(((bounds.getWest() + 180) / 360) * n) - 1);
    const x1 = Math.min(n - 1, Math.floor(((bounds.getEast() + 180) / 360) * n) + 1);
    const northY = worldTileY(bounds.getNorth(), zoom);
    const southY = worldTileY(bounds.getSouth(), zoom);
    const y0 = Math.max(0, Math.min(northY, southY) - 1);
    const y1 = Math.min(n - 1, Math.max(northY, southY) + 1);
    const revision = this.host.revision();
    const positions: number[] = [];
    this.visible.clear();

    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const coords = { x, y, z: zoom };
        if (!this.host.inRange(coords)) continue;
        const key = `${zoom}/${x}/${y}`;
        this.visible.add(key);
        let entry = this.textures.get(key);
        if (!entry || entry.revision !== revision) {
          const tile = this.cached(coords);
          if (!tile) continue;
          if (!this.host.paint(tile, this.pixels)) continue;
          if (!entry) {
            const texture = gl.createTexture();
            if (!texture) continue;
            entry = { texture, revision: -1 };
            this.textures.set(key, entry);
          }
          gl.bindTexture(gl.TEXTURE_2D, entry.texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TILE, TILE, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          entry.revision = revision;
        }
        const quad = tileLngLatBounds(x, y, zoom);
        const nw = MercatorCoordinate.fromLngLat({ lng: quad.west, lat: quad.north });
        const se = MercatorCoordinate.fromLngLat({ lng: quad.east, lat: quad.south });
        // defaultProjectionData.mainMatrix takes mercator coordinates, [0, 0] at the
        // north-west corner of the world. North edge is v = 1 because the upload flipped the image.
        positions.push(
          nw.x, nw.y, 0, 1,
          se.x, nw.y, 1, 1,
          se.x, se.y, 1, 0,
          nw.x, nw.y, 0, 1,
          se.x, se.y, 1, 0,
          nw.x, se.y, 0, 0,
        );
        this.drawTile(gl, program, buffer, entry.texture, options, positions);
        positions.length = 0;
      }
    }
    for (const [key, entry] of this.textures) {
      if (this.visible.has(key)) continue;
      gl.deleteTexture(entry.texture);
      this.textures.delete(key);
    }
    for (const key of [...this.requested]) {
      if (!this.visible.has(key)) this.requested.delete(key);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    const pos = gl.getAttribLocation(program, "a_pos");
    const uv = gl.getAttribLocation(program, "a_uv");
    gl.disableVertexAttribArray(pos);
    gl.disableVertexAttribArray(uv);
  }

  /** The tile if it is already decoded; otherwise start loading it and redraw later. */
  private cached(coords: { x: number; y: number; z: number }): SolarTile | null {
    const ready = this.host.peek(coords);
    if (ready) return ready;
    const key = `${coords.z}/${coords.x}/${coords.y}`;
    if (!this.requested.has(key)) {
      this.requested.add(key);
      void this.host.load(coords).then(() => {
        if (this.map) this.map.triggerRepaint();
      });
    }
    return null;
  }

  private drawTile(gl: WebGL2RenderingContext, program: WebGLProgram, buffer: WebGLBuffer, texture: WebGLTexture, options: CustomRenderMethodInput, positions: number[]) {
    // The 2D pass depth-tests against the basemap, which hides a flat overlay.
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    const pos = gl.getAttribLocation(program, "a_pos");
    const uv = gl.getAttribLocation(program, "a_uv");
    gl.enableVertexAttribArray(pos);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniformMatrix4fv(this.matrixLocation, false, new Float32Array(options.defaultProjectionData.mainMatrix));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private initGl(gl: WebGL2RenderingContext) {
    const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) return;
    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error(gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return;
    }
    this.program = program;
    this.buffer = gl.createBuffer();
    this.matrixLocation = gl.getUniformLocation(program, "u_matrix");
    const sampler = gl.getUniformLocation(program, "u_tex");
    gl.useProgram(program);
    if (sampler) gl.uniform1i(sampler, 0);
  }
}

function worldTileY(latitude: number, zoom: number) {
  const sin = Math.sin((latitude * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * 2 ** zoom;
  return Math.floor(y);
}
