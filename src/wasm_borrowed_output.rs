pub(crate) struct BorrowedDecodeOutput {
    bytes: Vec<u8>,
}

impl BorrowedDecodeOutput {
    pub(crate) fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    pub(crate) fn replace(&mut self, bytes: Vec<u8>) -> &[u8] {
        self.bytes = bytes;
        &self.bytes
    }
}
