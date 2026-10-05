//! Previous / play-pause / next buttons under Reson's taskbar preview (Windows thumbnail toolbar).
//!
//! The toolbar belongs to the main window's thread, so everything here runs on the main thread;
//! the audio engine calls [`update`], which hops over with `run_on_main_thread`.

use std::sync::mpsc::Sender;

use tauri::AppHandle;

use crate::player::Cmd;

#[cfg(windows)]
pub fn install(hwnd: isize, tx: Sender<Cmd>) {
    imp::install(hwnd, tx);
}

#[cfg(not(windows))]
pub fn install(_hwnd: isize, _tx: Sender<Cmd>) {}

/// Reflects playback in the buttons (the middle one shows play or pause).
pub fn update(app: &AppHandle, has_track: bool, playing: bool) {
    #[cfg(windows)]
    let _ = app.run_on_main_thread(move || imp::set_state(has_track, playing));
    #[cfg(not(windows))]
    let _ = (app, has_track, playing);
}

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::mpsc::Sender;
    use std::sync::OnceLock;

    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::UI::Shell::{
        DefSubclassProc, ITaskbarList3, SetWindowSubclass, TaskbarList, THBF_DISABLED, THBF_ENABLED, THBN_CLICKED,
        THB_FLAGS, THB_ICON, THB_TOOLTIP, THUMBBUTTON,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        ChangeWindowMessageFilterEx, CreateIconIndirect, GetSystemMetrics, RegisterWindowMessageW, HICON, ICONINFO,
        MSGFLT_ALLOW, SM_CXSMICON, WM_COMMAND,
    };

    use crate::player::Cmd;

    const PREV: u32 = 1;
    const TOGGLE: u32 = 2;
    const NEXT: u32 = 3;

    struct State {
        list: ITaskbarList3,
        hwnd: HWND,
        prev: HICON,
        play: HICON,
        pause: HICON,
        next: HICON,
        added: bool,
        has_track: bool,
        playing: bool,
    }

    thread_local! {
        static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
    }
    static COMMANDS: OnceLock<Sender<Cmd>> = OnceLock::new();
    /// "TaskbarButtonCreated": sent when the taskbar button exists (again, after Explorer restarts).
    static BUTTON_CREATED: AtomicU32 = AtomicU32::new(0);

    pub fn install(hwnd: isize, tx: Sender<Cmd>) {
        let _ = COMMANDS.set(tx);
        let hwnd = HWND(hwnd as *mut _);
        unsafe {
            let msg = RegisterWindowMessageW(w!("TaskbarButtonCreated"));
            BUTTON_CREATED.store(msg, Ordering::Relaxed);
            let _ = ChangeWindowMessageFilterEx(hwnd, msg, MSGFLT_ALLOW, None);
            let _ = ChangeWindowMessageFilterEx(hwnd, WM_COMMAND, MSGFLT_ALLOW, None);
            let Ok(list) = CoCreateInstance::<_, ITaskbarList3>(&TaskbarList, None, CLSCTX_INPROC_SERVER) else { return };
            if list.HrInit().is_err() {
                return;
            }
            let size = GetSystemMetrics(SM_CXSMICON).clamp(16, 64);
            let state = State {
                list,
                hwnd,
                prev: icon(size, Glyph::Prev),
                play: icon(size, Glyph::Play),
                pause: icon(size, Glyph::Pause),
                next: icon(size, Glyph::Next),
                added: false,
                has_track: false,
                playing: false,
            };
            STATE.with(|s| *s.borrow_mut() = Some(state));
            let _ = SetWindowSubclass(hwnd, Some(subclass), 0x5245_534f, 0);
        }
        // The button usually exists already (the window was created before setup ran).
        refresh();
    }

    pub fn set_state(has_track: bool, playing: bool) {
        STATE.with(|s| {
            if let Some(st) = s.borrow_mut().as_mut() {
                st.has_track = has_track;
                st.playing = playing;
            }
        });
        refresh();
    }

    fn button(id: u32, icon: HICON, tip: &str, enabled: bool) -> THUMBBUTTON {
        let mut sz_tip = [0u16; 260];
        for (dst, src) in sz_tip.iter_mut().zip(tip.encode_utf16()) {
            *dst = src;
        }
        THUMBBUTTON {
            dwMask: THB_ICON | THB_TOOLTIP | THB_FLAGS,
            iId: id,
            iBitmap: 0,
            hIcon: icon,
            szTip: sz_tip,
            dwFlags: if enabled { THBF_ENABLED } else { THBF_DISABLED },
        }
    }

    fn refresh() {
        STATE.with(|s| {
            let mut guard = s.borrow_mut();
            let Some(st) = guard.as_mut() else { return };
            let (toggle_icon, toggle_tip) = if st.playing { (st.pause, "Pause") } else { (st.play, "Play") };
            let buttons = [
                button(PREV, st.prev, "Previous", st.has_track),
                button(TOGGLE, toggle_icon, toggle_tip, st.has_track),
                button(NEXT, st.next, "Next", st.has_track),
            ];
            unsafe {
                if st.added {
                    let _ = st.list.ThumbBarUpdateButtons(st.hwnd, &buttons);
                } else if st.list.ThumbBarAddButtons(st.hwnd, &buttons).is_ok() {
                    st.added = true;
                }
            }
        });
    }

    unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _id: usize, _data: usize) -> LRESULT {
        if msg == BUTTON_CREATED.load(Ordering::Relaxed) && msg != 0 {
            STATE.with(|s| {
                if let Some(st) = s.borrow_mut().as_mut() {
                    st.added = false;
                }
            });
            refresh();
        } else if msg == WM_COMMAND && ((wparam.0 >> 16) & 0xffff) as u32 == THBN_CLICKED {
            let cmd = match (wparam.0 & 0xffff) as u32 {
                PREV => Some(Cmd::Prev),
                TOGGLE => Some(Cmd::Toggle),
                NEXT => Some(Cmd::Next),
                _ => None,
            };
            if let (Some(cmd), Some(tx)) = (cmd, COMMANDS.get()) {
                let _ = tx.send(cmd);
                return LRESULT(0);
            }
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    #[derive(Clone, Copy)]
    enum Glyph {
        Prev,
        Play,
        Pause,
        Next,
    }

    type Tri = [(f32, f32); 3];

    fn inside_tri(t: &Tri, x: f32, y: f32) -> bool {
        let sign = |a: (f32, f32), b: (f32, f32)| (x - b.0) * (a.1 - b.1) - (a.0 - b.0) * (y - b.1);
        let (d1, d2, d3) = (sign(t[0], t[1]), sign(t[1], t[2]), sign(t[2], t[0]));
        !((d1 < 0.0 || d2 < 0.0 || d3 < 0.0) && (d1 > 0.0 || d2 > 0.0 || d3 > 0.0))
    }

    fn covered(g: Glyph, x: f32, y: f32) -> bool {
        let rect = |x0: f32, y0: f32, x1: f32, y1: f32| x >= x0 && x <= x1 && y >= y0 && y <= y1;
        match g {
            Glyph::Play => inside_tri(&[(0.27, 0.16), (0.27, 0.84), (0.85, 0.5)], x, y),
            Glyph::Pause => rect(0.24, 0.17, 0.42, 0.83) || rect(0.58, 0.17, 0.76, 0.83),
            Glyph::Prev => rect(0.18, 0.2, 0.3, 0.8) || inside_tri(&[(0.84, 0.2), (0.84, 0.8), (0.32, 0.5)], x, y),
            Glyph::Next => rect(0.7, 0.2, 0.82, 0.8) || inside_tri(&[(0.16, 0.2), (0.16, 0.8), (0.68, 0.5)], x, y),
        }
    }

    /// Draws a white glyph with 4x4 supersampled edges into an HICON.
    fn icon(size: i32, glyph: Glyph) -> HICON {
        let n = size as usize;
        let mut bgra = vec![0u8; n * n * 4];
        for py in 0..n {
            for px in 0..n {
                let mut hits = 0;
                for sy in 0..4 {
                    for sx in 0..4 {
                        let x = (px as f32 + (sx as f32 + 0.5) / 4.0) / n as f32;
                        let y = (py as f32 + (sy as f32 + 0.5) / 4.0) / n as f32;
                        hits += covered(glyph, x, y) as u32;
                    }
                }
                let a = (hits * 255 / 16) as u8;
                let i = (py * n + px) * 4;
                bgra[i..i + 4].copy_from_slice(&[255, 255, 255, a]);
            }
        }
        // 1-bpp rows are padded to 16 bits; an all-zero mask lets the alpha channel decide.
        let mask = vec![0u8; n.div_ceil(16) * 2 * n];
        unsafe {
            let color = CreateBitmap(size, size, 1, 32, Some(bgra.as_ptr().cast()));
            let mask = CreateBitmap(size, size, 1, 1, Some(mask.as_ptr().cast()));
            let info = ICONINFO { fIcon: true.into(), xHotspot: 0, yHotspot: 0, hbmMask: mask, hbmColor: color };
            let icon = CreateIconIndirect(&info).unwrap_or_default();
            // The icon keeps its own copies of the bitmaps.
            let _ = DeleteObject(color.into());
            let _ = DeleteObject(mask.into());
            icon
        }
    }
}
