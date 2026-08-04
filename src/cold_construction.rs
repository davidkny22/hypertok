#[cfg(feature = "cold-construction-profiling")]
use serde::Serialize;
#[cfg(feature = "cold-construction-profiling")]
use std::cell::RefCell;

#[cfg(all(feature = "cold-construction-profiling", target_arch = "wasm32"))]
use wasm_bindgen::prelude::*;

#[cfg(all(feature = "cold-construction-profiling", target_arch = "wasm32"))]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = performance, js_name = now)]
    fn performance_now() -> f64;
}

#[cfg(feature = "cold-construction-profiling")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stage {
    name: &'static str,
    milliseconds: f64,
}

#[cfg(feature = "cold-construction-profiling")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    schema_version: u32,
    total_milliseconds: f64,
    stages: Vec<Stage>,
}

#[cfg(feature = "cold-construction-profiling")]
struct ActiveProfile {
    started: Clock,
    stages: Vec<Stage>,
}

#[cfg(all(feature = "cold-construction-profiling", not(target_arch = "wasm32")))]
struct Clock(std::time::Instant);

#[cfg(all(feature = "cold-construction-profiling", target_arch = "wasm32"))]
struct Clock(f64);

#[cfg(feature = "cold-construction-profiling")]
impl Clock {
    fn now() -> Self {
        #[cfg(target_arch = "wasm32")]
        {
            Self(performance_now())
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            Self(std::time::Instant::now())
        }
    }

    fn elapsed_ms(&self) -> f64 {
        #[cfg(target_arch = "wasm32")]
        {
            performance_now() - self.0
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.0.elapsed().as_secs_f64() * 1_000.0
        }
    }
}

#[cfg(feature = "cold-construction-profiling")]
thread_local! {
    static ACTIVE: RefCell<Option<ActiveProfile>> = const { RefCell::new(None) };
    static LAST: RefCell<Option<Profile>> = const { RefCell::new(None) };
}

#[cfg(feature = "cold-construction-profiling")]
pub(crate) fn begin() {
    ACTIVE.with(|active| {
        *active.borrow_mut() = Some(ActiveProfile {
            started: Clock::now(),
            stages: Vec::new(),
        });
    });
}

#[cfg(not(feature = "cold-construction-profiling"))]
pub(crate) fn begin() {}

#[cfg(feature = "cold-construction-profiling")]
pub(crate) fn measure<T>(name: &'static str, operation: impl FnOnce() -> T) -> T {
    let started = Clock::now();
    let result = operation();
    let milliseconds = started.elapsed_ms();
    ACTIVE.with(|active| {
        if let Some(profile) = active.borrow_mut().as_mut() {
            profile.stages.push(Stage { name, milliseconds });
        }
    });
    result
}

#[cfg(not(feature = "cold-construction-profiling"))]
#[inline]
pub(crate) fn measure<T>(_name: &'static str, operation: impl FnOnce() -> T) -> T {
    operation()
}

#[cfg(feature = "cold-construction-profiling")]
pub(crate) fn finish() {
    ACTIVE.with(|active| {
        if let Some(profile) = active.borrow_mut().take() {
            LAST.with(|last| {
                *last.borrow_mut() = Some(Profile {
                    schema_version: 1,
                    total_milliseconds: profile.started.elapsed_ms(),
                    stages: profile.stages,
                });
            });
        }
    });
}

#[cfg(not(feature = "cold-construction-profiling"))]
pub(crate) fn finish() {}

#[cfg(feature = "cold-construction-profiling")]
pub(crate) fn last_json() -> Result<String, serde_json::Error> {
    LAST.with(|last| serde_json::to_string(&*last.borrow()))
}
