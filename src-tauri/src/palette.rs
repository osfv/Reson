//! Extracts a UI palette from album art.
//!
//! The UI is always dark, so the palette is shaped for that: a deep background tinted with the
//! cover's dominant hue, a slightly lifted surface, and the most vivid color in the art as the
//! accent. The accent is pushed until it reaches WCAG AA contrast against the background, and the
//! text color used on top of the accent is picked by contrast as well.

use image::{imageops::FilterType, DynamicImage};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Palette {
    pub bg: String,
    pub surface: String,
    pub accent: String,
    pub on_accent: String,
    /// 3-4 deep tones from the art, for the Now Playing gradient backdrop.
    #[serde(default)]
    pub swatches: Vec<String>,
}

#[derive(Clone, Copy)]
struct Hsl {
    h: f32,
    s: f32,
    l: f32,
}

pub fn extract(img: &DynamicImage) -> Palette {
    let small = img.resize_exact(48, 48, FilterType::Triangle).to_rgba8();
    let pixels: Vec<[f32; 3]> = small
        .pixels()
        .filter(|p| p[3] > 128)
        .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
        .collect();
    if pixels.is_empty() {
        return from_seed(Hsl { h: 0.0, s: 0.0, l: 0.5 }, Hsl { h: 36.0, s: 0.85, l: 0.66 });
    }

    let clusters = kmeans(&pixels, 6, 12);
    let total = pixels.len() as f32;
    let mut colors: Vec<Swatch> = clusters
        .iter()
        .filter(|(_, n)| *n > 0)
        .map(|(c, n)| Swatch { hsl: rgb_to_hsl(*c), chroma: chroma(*c), share: *n as f32 / total })
        .collect();
    colors.sort_by(|a, b| b.share.total_cmp(&a.share));

    // Prefer a colorful cluster for the background tint if it is reasonably large, otherwise the
    // dominant one. Colorfulness is judged by RGB chroma: HSL saturation is inflated for very dark
    // or very light pixels, which would tint black-and-white covers.
    let base = colors
        .iter()
        .find(|s| s.chroma > 0.12 && s.share > 0.18)
        .unwrap_or(&colors[0]);
    let base_hsl = Hsl { s: base.hsl.s.min(base.chroma * 2.5), ..base.hsl };

    let accent = colors
        .iter()
        .filter(|s| s.share > 0.03 && s.chroma > 0.15)
        .max_by(|a, b| accent_score(a).total_cmp(&accent_score(b)))
        .map(|s| s.hsl)
        .unwrap_or(Hsl { h: base_hsl.h, s: (base_hsl.s * 0.5).min(0.2), l: 0.84 });

    let mut p = from_seed(base_hsl, accent);
    p.swatches = swatches(&colors, base_hsl);
    p
}

/// Deep, saturated-but-not-neon versions of the main colors, darkest-safe for a backdrop.
fn swatches(colors: &[Swatch], base: Hsl) -> Vec<String> {
    let mut out: Vec<Hsl> = colors
        .iter()
        .filter(|s| s.share > 0.04)
        .take(4)
        .map(|s| Hsl { h: s.hsl.h, s: s.hsl.s.min(s.chroma * 2.5).min(0.7), l: s.hsl.l.clamp(0.16, 0.4) })
        .collect();
    // Monochrome art: fan out around the base hue so the gradient still has some movement.
    let mut i = 0;
    while out.len() < 3 {
        i += 1;
        out.push(Hsl { h: (base.h + 25.0 * i as f32).rem_euclid(360.0), s: base.s.min(0.35), l: 0.14 + 0.06 * i as f32 });
    }
    out.into_iter().map(|c| hex(hsl_to_rgb(c))).collect()
}

/// Bump when the extraction changes so cached palettes are recomputed on next launch.
pub const VERSION: u32 = 3;

struct Swatch {
    hsl: Hsl,
    chroma: f32,
    share: f32,
}

fn chroma([r, g, b]: [f32; 3]) -> f32 {
    r.max(g).max(b) - r.min(g).min(b)
}

fn accent_score(s: &Swatch) -> f32 {
    let vivid = s.chroma * (1.0 - (s.hsl.l - 0.55).abs() * 1.4).max(0.05);
    vivid * s.share.powf(0.3)
}

fn from_seed(base: Hsl, accent: Hsl) -> Palette {
    let bg = Hsl { h: base.h, s: base.s.min(0.5), l: 0.11 };
    let surface = Hsl { h: base.h, s: base.s.min(0.4), l: 0.17 };

    let mut acc = Hsl { h: accent.h, s: accent.s.clamp(0.0, 0.82), l: accent.l.clamp(0.56, 0.8) };
    let bg_rgb = hsl_to_rgb(bg);
    while contrast(hsl_to_rgb(acc), bg_rgb) < 4.5 && acc.l < 0.92 {
        acc.l += 0.02;
    }

    let acc_rgb = hsl_to_rgb(acc);
    let dark = hsl_to_rgb(Hsl { h: accent.h, s: 0.35, l: 0.08 });
    let light = [0.96, 0.955, 0.945];
    let on_accent = if contrast(acc_rgb, dark) >= contrast(acc_rgb, light) { dark } else { light };

    Palette {
        bg: hex(bg_rgb),
        surface: hex(hsl_to_rgb(surface)),
        accent: hex(acc_rgb),
        on_accent: hex(on_accent),
        swatches: Vec::new(),
    }
}

fn kmeans(pixels: &[[f32; 3]], k: usize, iters: usize) -> Vec<([f32; 3], usize)> {
    // Deterministic seeding: spread initial centers across the luminance-sorted pixels.
    let mut sorted: Vec<&[f32; 3]> = pixels.iter().collect();
    sorted.sort_by(|a, b| luminance(**a).total_cmp(&luminance(**b)));
    let mut centers: Vec<[f32; 3]> =
        (0..k).map(|i| *sorted[(i * 2 + 1) * sorted.len() / (k * 2)]).collect();
    let mut counts = vec![0usize; k];

    for _ in 0..iters {
        let mut sums = vec![[0f32; 3]; k];
        counts.iter_mut().for_each(|c| *c = 0);
        for p in pixels {
            let idx = nearest(&centers, p);
            counts[idx] += 1;
            for c in 0..3 {
                sums[idx][c] += p[c];
            }
        }
        for i in 0..k {
            if counts[i] > 0 {
                centers[i] = sums[i].map(|s| s / counts[i] as f32);
            }
        }
    }
    centers.into_iter().zip(counts).collect()
}

fn nearest(centers: &[[f32; 3]], p: &[f32; 3]) -> usize {
    centers
        .iter()
        .enumerate()
        .map(|(i, c)| (i, (0..3).map(|j| (c[j] - p[j]).powi(2)).sum::<f32>()))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
        .unwrap_or(0)
}

fn rgb_to_hsl([r, g, b]: [f32; 3]) -> Hsl {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    let d = max - min;
    if d < 1e-5 {
        return Hsl { h: 0.0, s: 0.0, l };
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs());
    let h = if max == r {
        60.0 * (((g - b) / d).rem_euclid(6.0))
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    Hsl { h, s: s.clamp(0.0, 1.0), l }
}

fn hsl_to_rgb(Hsl { h, s, l }: Hsl) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((h / 60.0).rem_euclid(2.0) - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match (h / 60.0) as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    [r + m, g + m, b + m]
}

fn luminance(rgb: [f32; 3]) -> f32 {
    let lin = |c: f32| if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) };
    0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}

fn contrast(a: [f32; 3], b: [f32; 3]) -> f32 {
    let (la, lb) = (luminance(a), luminance(b));
    (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
}

fn hex(rgb: [f32; 3]) -> String {
    let c = rgb.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8);
    format!("#{:02x}{:02x}{:02x}", c[0], c[1], c[2])
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    #[test]
    fn grayscale_art_stays_neutral() {
        let mut img = RgbaImage::new(64, 64);
        for (x, y, p) in img.enumerate_pixels_mut() {
            // Mostly near-black with a faint warm cast and a light-gray subject.
            *p = if (x as i32 - 32).pow(2) + (y as i32 - 32).pow(2) < 300 {
                Rgba([200, 196, 194, 255])
            } else {
                Rgba([22, 18, 19, 255])
            };
        }
        let p = extract(&DynamicImage::ImageRgba8(img));
        let rgb = |h: &str| {
            let v = u32::from_str_radix(&h[1..], 16).unwrap();
            [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
        };
        for hex in [&p.bg, &p.accent] {
            let c = rgb(hex);
            let spread = c.iter().max().unwrap() - c.iter().min().unwrap();
            assert!(spread <= 14, "expected near-neutral, got {hex} in {p:?}");
        }
    }

    #[test]
    fn accent_is_readable_on_background() {
        for color in [[200u8, 30, 40], [20, 20, 120], [250, 230, 60], [128, 128, 128], [5, 5, 5]] {
            let img = RgbaImage::from_pixel(64, 64, Rgba([color[0], color[1], color[2], 255]));
            let p = extract(&DynamicImage::ImageRgba8(img));
            let parse = |h: &str| {
                let v = u32::from_str_radix(&h[1..], 16).unwrap();
                [(v >> 16) as f32 / 255.0, ((v >> 8) & 0xff) as f32 / 255.0, (v & 0xff) as f32 / 255.0]
            };
            assert!(contrast(parse(&p.accent), parse(&p.bg)) >= 4.5, "{color:?} -> {p:?}");
            assert!(contrast(parse(&p.accent), parse(&p.on_accent)) >= 4.5, "{color:?} -> {p:?}");
        }
    }
}
