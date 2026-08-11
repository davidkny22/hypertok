const BYTE_PAIRS: usize = 1 << 16;
const WORD_BITS: usize = u64::BITS as usize;
const WORDS: usize = BYTE_PAIRS / WORD_BITS;

pub(crate) struct ForceSplitBigrams {
    words: Box<[u64; WORDS]>,
}

impl ForceSplitBigrams {
    pub(crate) fn from_vocabulary<T: AsRef<[u8]>>(vocabulary: &[T]) -> Self {
        let mut words = Box::new([0_u64; WORDS]);
        for token in vocabulary {
            for pair in token.as_ref().windows(2) {
                let key = pair[0] as usize * 256 + pair[1] as usize;
                words[key / WORD_BITS] |= 1_u64 << (key % WORD_BITS);
            }
        }
        Self { words }
    }

    #[inline]
    pub(crate) fn may_join(&self, left: u8, right: u8) -> bool {
        let key = left as usize * 256 + right as usize;
        self.words[key / WORD_BITS] & (1_u64 << (key % WORD_BITS)) != 0
    }

    pub(crate) fn boundaries<'a>(&'a self, bytes: &'a [u8]) -> impl Iterator<Item = usize> + 'a {
        bytes
            .windows(2)
            .enumerate()
            .filter(|(_, pair)| !self.may_join(pair[0], pair[1]))
            .map(|(index, _)| index + 1)
    }
}
