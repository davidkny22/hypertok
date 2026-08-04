pub(crate) struct ResidentOutput {
    ids: Vec<u32>,
}

impl ResidentOutput {
    pub(crate) fn new() -> Self {
        Self { ids: Vec::new() }
    }

    pub(crate) fn ids_mut(&mut self) -> &mut Vec<u32> {
        self.ids.clear();
        &mut self.ids
    }

    pub(crate) fn len(&self) -> usize {
        self.ids.len()
    }

    pub(crate) fn view(&self) -> js_sys::Uint32Array {
        // SAFETY: JavaScript acquires this view after encoding and copies it
        // before any later WebAssembly call can move the vector or memory.
        unsafe { js_sys::Uint32Array::view(self.ids.as_slice()) }
    }

    pub(crate) fn capacity_bytes(&self) -> usize {
        self.ids.capacity() * size_of::<u32>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_retains_output_capacity() {
        let mut output = ResidentOutput::new();
        output.ids_mut().extend(0..4096);
        let capacity = output.capacity_bytes();

        assert!(output.ids_mut().is_empty());
        assert_eq!(output.capacity_bytes(), capacity);
    }
}
