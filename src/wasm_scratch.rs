pub(crate) struct WasmScratch {
    output: Vec<u32>,
    flat_ranges: Vec<u32>,
}

impl WasmScratch {
    pub(crate) fn new() -> Self {
        Self {
            output: Vec::new(),
            flat_ranges: Vec::new(),
        }
    }

    pub(crate) fn output_mut(&mut self) -> &mut Vec<u32> {
        self.output.clear();
        &mut self.output
    }

    pub(crate) fn flat_ranges_mut(&mut self) -> &mut Vec<u32> {
        self.flat_ranges.clear();
        &mut self.flat_ranges
    }

    pub(crate) fn vectors_mut(&mut self) -> (&mut Vec<u32>, &mut Vec<u32>) {
        self.output.clear();
        self.flat_ranges.clear();
        (&mut self.output, &mut self.flat_ranges)
    }

    pub(crate) fn output_array(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.output.as_slice())
    }

    pub(crate) fn flat_ranges_array(&self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.flat_ranges.as_slice())
    }

    pub(crate) fn output_capacity_bytes(&self) -> usize {
        self.output.capacity() * size_of::<u32>()
    }

    pub(crate) fn flat_range_capacity_bytes(&self) -> usize {
        self.flat_ranges.capacity() * size_of::<u32>()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clear_retains_capacity_for_both_vectors() {
        let mut scratch = WasmScratch::new();
        scratch.output_mut().extend(0..4096);
        scratch.flat_ranges_mut().extend(0..2048);
        let output_capacity = scratch.output_capacity_bytes();
        let range_capacity = scratch.flat_range_capacity_bytes();

        assert!(scratch.output_mut().is_empty());
        assert!(scratch.flat_ranges_mut().is_empty());
        assert_eq!(scratch.output_capacity_bytes(), output_capacity);
        assert_eq!(scratch.flat_range_capacity_bytes(), range_capacity);
    }
}
