pub(crate) const INITIAL_IDS: usize = 64 * 1024 / size_of::<u32>();
pub(crate) const SHRINK_BOUND_IDS: usize = 4 * 1024 * 1024 / size_of::<u32>();

pub(crate) struct ResidentIds {
    ids: Vec<u32>,
    high_water: usize,
}

impl ResidentIds {
    pub(crate) fn new() -> Self {
        Self {
            ids: vec![0; INITIAL_IDS],
            high_water: INITIAL_IDS,
        }
    }

    pub(crate) fn ids(&self) -> &[u32] {
        &self.ids
    }

    pub(crate) fn capacity(&self) -> usize {
        self.ids.len()
    }

    pub(crate) fn high_water(&self) -> usize {
        self.high_water
    }

    pub(crate) fn grow(&mut self) -> Result<(), &'static str> {
        let next = self
            .ids
            .len()
            .checked_mul(2)
            .ok_or("resident decode id capacity overflow")?;
        self.ids.resize(next, 0);
        self.high_water = self.high_water.max(next);
        Ok(())
    }

    pub(crate) fn finish_call(&mut self, used: usize) -> Result<(), &'static str> {
        if used > self.ids.len() {
            return Err("resident decode id length exceeds capacity");
        }
        if self.high_water > SHRINK_BOUND_IDS && used < self.high_water / 4 {
            self.ids.resize(SHRINK_BOUND_IDS, 0);
            self.ids.shrink_to_fit();
            self.high_water = SHRINK_BOUND_IDS;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn growth_is_geometric_and_shrink_is_strict() {
        let mut ids = ResidentIds::new();
        assert_eq!(ids.capacity(), INITIAL_IDS);
        let mut previous = ids.capacity();
        while ids.capacity() < 2 * SHRINK_BOUND_IDS {
            ids.grow().unwrap();
            assert_eq!(ids.capacity(), previous * 2);
            previous = ids.capacity();
        }
        assert_eq!(ids.high_water(), 2 * SHRINK_BOUND_IDS);

        ids.finish_call(SHRINK_BOUND_IDS / 2).unwrap();
        assert_eq!(ids.capacity(), 2 * SHRINK_BOUND_IDS);
        ids.finish_call(SHRINK_BOUND_IDS / 2 - 1).unwrap();
        assert_eq!(ids.capacity(), SHRINK_BOUND_IDS);
        assert_eq!(ids.high_water(), SHRINK_BOUND_IDS);
    }

    #[test]
    fn invalid_used_length_is_rejected() {
        let mut ids = ResidentIds::new();
        assert!(ids.finish_call(INITIAL_IDS + 1).is_err());
    }
}
