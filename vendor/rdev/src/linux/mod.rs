extern crate libc;
extern crate x11;

mod common;
mod display;
mod grab;
mod keyboard;
mod listen;
mod simulate;

pub use crate::linux::display::display_size;
pub use crate::linux::grab::{
    disable_grab, enable_grab, exit_grab_listen, is_grabbed, start_grab_listen,
};
pub use crate::linux::keyboard::Keyboard;
// ready 必须由 XRecord 的 StartOfData 触发，调用方不能把“Context 已创建”误当成已经可收事件。
pub use crate::linux::listen::{listen, listen_with_ready};
pub use crate::linux::simulate::{simulate, simulate_char, simulate_unicode};
