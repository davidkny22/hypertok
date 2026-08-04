use crate::VarintError;

pub fn encode_u32(mut value: u32, output: &mut Vec<u8>) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            output.push(byte);
            return;
        }
        output.push(byte | 0x80);
    }
}

pub fn decode_u32(input: &[u8]) -> Result<(u32, usize), VarintError> {
    let mut value = 0_u32;

    for index in 0..5 {
        let byte = *input.get(index).ok_or(VarintError::UnexpectedEnd)?;
        if index == 4 && (byte & 0xf0) != 0 {
            return Err(VarintError::Overflow);
        }

        value |= u32::from(byte & 0x7f) << (index * 7);
        if byte & 0x80 == 0 {
            if index > 0 && byte == 0 {
                return Err(VarintError::NonCanonical);
            }
            return Ok((value, index + 1));
        }
    }

    Err(VarintError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::{decode_u32, encode_u32};
    use crate::VarintError;

    #[test]
    fn canonical_boundaries_round_trip() {
        for value in [0, 1, 127, 128, 16_383, 16_384, 1 << 28, u32::MAX] {
            let mut encoded = Vec::new();
            encode_u32(value, &mut encoded);
            assert_eq!(decode_u32(&encoded), Ok((value, encoded.len())));
        }
    }

    #[test]
    fn malformed_encodings_are_typed() {
        assert_eq!(decode_u32(&[]), Err(VarintError::UnexpectedEnd));
        assert_eq!(decode_u32(&[0x80, 0]), Err(VarintError::NonCanonical));
        assert_eq!(decode_u32(&[0xff; 5]), Err(VarintError::Overflow));
        assert_eq!(
            decode_u32(&[0xff, 0xff, 0xff, 0xff, 0x10]),
            Err(VarintError::Overflow)
        );
    }
}
