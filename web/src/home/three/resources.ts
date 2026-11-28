import { BoxGeometry, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry, DataTexture, IcosahedronGeometry, MeshStandardMaterial, SRGBColorSpace, type Texture } from "three";
import type { HomeShape } from "../../../../src/home/scene.js";

/**
 * Geometry, materials and textures shared across a scene: one unit geometry
 * per shape (a mesh scales it to its size), one material per colour for
 * parts nothing recolours, one texture per picture. Everything made here is
 * disposed with the scene.
 */

/** Unit shapes standing on their base (y from 0 to 1), low-poly. */
function unit(geometry: BufferGeometry): BufferGeometry { geometry.translate(0, 0.5, 0); return geometry; }

export const PICTURE_MAX_PX = 1024;
/** All sign canvases together stay under this many pixels (GPU memory). */
export const SIGN_PIXEL_BUDGET = 8_000_000;

export class Resources {
  private geometries = new Map<string, BufferGeometry>();
  private materials = new Map<string, MeshStandardMaterial>();
  private owned = new Set<{ dispose(): void }>();
  private pictures = new Map<string, { texture: Texture | null; waiting: Array<(texture: Texture) => void> }>();
  private disposed = false;
  /** A 1×1 stand-in, so a panel's material never changes shape when its texture arrives. */
  readonly blank: DataTexture;

  constructor(private readonly assetUrl: (name: string) => string, private readonly onChange: () => void) {
    this.blank = new DataTexture(new Uint8Array([233, 225, 208, 255]), 1, 1);
    this.blank.colorSpace = SRGBColorSpace; this.blank.needsUpdate = true;
    this.owned.add(this.blank);
  }

  geometry(shape: HomeShape | "panel"): BufferGeometry {
    let geometry = this.geometries.get(shape);
    if (!geometry) {
      geometry = shape === "box" || shape === "panel" ? unit(new BoxGeometry(1, 1, 1))
        : shape === "cylinder" ? unit(new CylinderGeometry(0.5, 0.5, 1, 12))
        : shape === "cone" ? unit(new ConeGeometry(0.5, 1, 10))
        : unit(new IcosahedronGeometry(0.5, 1));
      this.geometries.set(shape, geometry);
    }
    return geometry;
  }

  /** The shared material of a colour. Never change it: ask for `own` instead. */
  shared(color: string): MeshStandardMaterial {
    let material = this.materials.get(color);
    if (!material) { material = this.own(color); this.materials.set(color, material); }
    return material;
  }
  /** A material of its own, for a part that glows or changes colour. */
  own(color: string, map?: Texture): MeshStandardMaterial {
    const material = new MeshStandardMaterial({ color: new Color(color), flatShading: true, roughness: 0.88, metalness: 0, ...(map ? { map } : {}) });
    this.owned.add(material);
    return material;
  }
  /** A canvas texture this scene owns (signs). */
  canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace; texture.anisotropy = 4;
    this.owned.add(texture);
    return texture;
  }

  /**
   * `home/assets/<name>`, only ever loaded as an image, drawn to a canvas no
   * larger than PICTURE_MAX_PX. `use` runs once it is there (now, if it is).
   */
  picture(name: string, use: (texture: Texture) => void): void {
    const known = this.pictures.get(name);
    // eslint-disable-next-line react-hooks/rules-of-hooks -- a callback parameter named `use`, not React's use() hook
    if (known) { if (known.texture) use(known.texture); else known.waiting.push(use); return; }
    const entry = { texture: null as Texture | null, waiting: [use] };
    this.pictures.set(name, entry);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (this.disposed) return;
      const natural = Math.max(image.naturalWidth, image.naturalHeight);
      const scale = natural ? Math.min(1, PICTURE_MAX_PX / natural) : 1;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round((image.naturalWidth || 512) * scale));
      canvas.height = Math.max(1, Math.round((image.naturalHeight || 512) * scale));
      canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height);
      entry.texture = this.canvasTexture(canvas);
      for (const waiting of entry.waiting.splice(0)) waiting(entry.texture);
      this.onChange();
    };
    // A missing or unreadable picture keeps its blank panel.
    image.onerror = () => { entry.waiting = []; };
    image.src = this.assetUrl(name);
  }

  dispose(): void {
    this.disposed = true;
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const item of this.owned) item.dispose();
    this.geometries.clear(); this.materials.clear(); this.owned.clear(); this.pictures.clear();
  }
}

/** Pixels for a sign of `width`×`height` metres: ~256 px per metre, at most 1024 wide. */
export function signCanvasSize(width: number, height: number, scale = 1): [number, number] {
  let h = Math.max(24, Math.min(256, Math.round(height * 256))) * scale;
  let w = h * width / height;
  if (w > 1024) { h = h * 1024 / w; w = 1024; }
  return [Math.max(16, Math.round(w)), Math.max(8, Math.round(h))];
}

export const SIGN_FONT = '"Source Serif 4", Georgia, serif';
/** One line of text on its background, as large as fits; an ellipsis if even the smallest size does not. */
export function drawSign(canvas: HTMLCanvasElement, text: string, color: string, background: string): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  context.fillStyle = background; context.fillRect(0, 0, width, height);
  if (!text) return;
  const pad = Math.max(4, height * 0.14), room = width - pad * 2;
  let size = height * 0.6;
  const font = (px: number) => `600 ${px}px ${SIGN_FONT}`;
  context.font = font(size);
  let measured = context.measureText(text).width;
  if (measured > room) { size = Math.max(height * 0.3, size * room / measured); context.font = font(size); measured = context.measureText(text).width; }
  let shown = text;
  while (measured > room && shown.length > 1) { shown = shown.slice(0, -1); measured = context.measureText(`${shown}…`).width; }
  if (shown !== text) shown = `${shown.trimEnd()}…`;
  context.fillStyle = color; context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText(shown, width / 2, height / 2 + size * 0.04);
}
