pub(crate) const INITIAL_BYTES: usize = 64 * 1024;
pub(crate) const SHRINK_BOUND_BYTES: usize = 4 * 1024 * 1024;

pub(crate) struct ResidentInput {
    bytes: Vec<u8>,
    high_water: usize,
}

impl ResidentInput {
    pub(crate) fn new() -> Self {
        Self {
            bytes: vec![0; INITIAL_BYTES],
            high_water: INITIAL_BYTES,
        }
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub(crate) fn capacity(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn high_water(&self) -> usize {
        self.high_water
    }

    pub(crate) fn grow(&mut self) -> Result<(), &'static str> {
        let next = self
            .bytes
            .len()
            .checked_mul(2)
            .ok_or("resident input capacity overflow")?;
        self.bytes.resize(next, 0);
        self.high_water = self.high_water.max(next);
        Ok(())
    }

    pub(crate) fn finish_call(&mut self, used: usize) -> Result<(), &'static str> {
        if used > self.bytes.len() {
            return Err("resident input length exceeds capacity");
        }
        if self.high_water > SHRINK_BOUND_BYTES && used < self.high_water / 4 {
            self.bytes.resize(SHRINK_BOUND_BYTES, 0);
            self.bytes.shrink_to_fit();
            self.high_water = SHRINK_BOUND_BYTES;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn growth_is_geometric_and_shrink_is_strict() {
        let mut input = ResidentInput::new();
        assert_eq!(input.capacity(), INITIAL_BYTES);
        let mut previous = input.capacity();
        while input.capacity() < 8 * 1024 * 1024 {
            input.grow().unwrap();
            assert_eq!(input.capacity(), previous * 2);
            previous = input.capacity();
        }
        assert_eq!(input.high_water(), 8 * 1024 * 1024);

        input.finish_call(2 * 1024 * 1024).unwrap();
        assert_eq!(input.capacity(), 8 * 1024 * 1024);
        input.finish_call(2 * 1024 * 1024 - 1).unwrap();
        assert_eq!(input.capacity(), SHRINK_BOUND_BYTES);
        assert_eq!(input.high_water(), SHRINK_BOUND_BYTES);
    }

    #[test]
    fn invalid_used_length_is_rejected() {
        let mut input = ResidentInput::new();
        assert!(input.finish_call(INITIAL_BYTES + 1).is_err());
    }
}
