extern crate winapi;

mod common;
mod display;
mod grab;
mod keyboard;
mod listen;
mod simulate;

pub use crate::windows::common::*;
pub use crate::windows::display::display_size;
pub use crate::windows::grab::{exit_grab, grab, is_grabbed, set_event_popup, set_get_key_unicode};
pub use crate::windows::keyboard::Keyboard;
// ready 只在所需 user32 Hook 全部安装成功后触发，避免应用过早进入可用状态。
pub use crate::windows::listen::{listen, listen_with_ready};
pub use crate::windows::simulate::*;
