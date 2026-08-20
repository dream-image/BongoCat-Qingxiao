mod common;
mod display;
mod grab;
mod keyboard;
mod listen;
mod simulate;

pub use crate::macos::common::{map_keycode, set_is_main_thread};
pub use crate::macos::display::display_size;
pub use crate::macos::grab::{exit_grab, grab, is_grabbed};
pub use crate::macos::keyboard::Keyboard;
pub use crate::macos::listen::{listen, listen_with_ready, listen_with_ready_and_error};
pub use crate::macos::simulate::{
    set_keyboard_extra_info, set_mouse_extra_info, simulate, VirtualInput,
};
