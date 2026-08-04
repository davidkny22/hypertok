use std::cell::Cell;

const NON_ASCII_NUMERATOR: usize = 1;
const NON_ASCII_DENOMINATOR: usize = 5;
const ASCII_HIGH_BITS: u64 = 0x8080_8080_8080_8080;

thread_local! {
    static FORCE_SCALAR: Cell<bool> = const { Cell::new(false) };
    static LAST_SCALAR: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn scalar_scanner_forced() -> bool {
    FORCE_SCALAR.get()
}

pub(crate) fn with_scalar_scanner<T>(enabled: bool, operation: impl FnOnce() -> T) -> T {
    LAST_SCALAR.set(enabled);
    let previous = FORCE_SCALAR.replace(enabled);
    struct Reset(bool);
    impl Drop for Reset {
        fn drop(&mut self) {
            FORCE_SCALAR.set(self.0);
        }
    }
    let reset = Reset(previous);
    let result = operation();
    drop(reset);
    result
}

pub(crate) fn last_scalar_scanner() -> bool {
    LAST_SCALAR.get()
}

pub(crate) fn validate_and_select_scalar(input: &[u8]) -> Result<bool, std::str::Utf8Error> {
    let mut index = 0;
    let mut non_ascii = 0;
    while index < input.len() {
        while input.len() - index >= 16 {
            let first = u64::from_ne_bytes(input[index..index + 8].try_into().unwrap());
            let second = u64::from_ne_bytes(input[index + 8..index + 16].try_into().unwrap());
            if (first | second) & ASCII_HIGH_BITS != 0 {
                break;
            }
            index += 16;
        }
        if index == input.len() {
            break;
        }
        let first = input[index];
        if first < 0x80 {
            index += 1;
            continue;
        }

        let width = if (0xc2..=0xdf).contains(&first) {
            2
        } else if (0xe0..=0xef).contains(&first) {
            3
        } else if (0xf0..=0xf4).contains(&first) {
            4
        } else {
            return std::str::from_utf8(input).map(|_| false);
        };
        let Some(sequence) = input.get(index..index + width) else {
            return std::str::from_utf8(input).map(|_| false);
        };
        let continuation = |byte: u8| byte & 0xc0 == 0x80;
        let valid = match width {
            2 => continuation(sequence[1]),
            3 => {
                continuation(sequence[2])
                    && match first {
                        0xe0 => (0xa0..=0xbf).contains(&sequence[1]),
                        0xed => (0x80..=0x9f).contains(&sequence[1]),
                        _ => continuation(sequence[1]),
                    }
            }
            4 => {
                continuation(sequence[2])
                    && continuation(sequence[3])
                    && match first {
                        0xf0 => (0x90..=0xbf).contains(&sequence[1]),
                        0xf4 => (0x80..=0x8f).contains(&sequence[1]),
                        _ => continuation(sequence[1]),
                    }
            }
            _ => unreachable!(),
        };
        if !valid {
            return std::str::from_utf8(input).map(|_| false);
        }
        non_ascii += width;
        index += width;
    }

    Ok(non_ascii.saturating_mul(NON_ASCII_DENOMINATOR)
        >= input.len().saturating_mul(NON_ASCII_NUMERATOR))
}

#[cfg(test)]
mod tests {
    use super::{FORCE_SCALAR, validate_and_select_scalar, with_scalar_scanner};

    #[test]
    fn matches_standard_utf8_validation() {
        for first in 0_u16..=255 {
            for second in 0_u16..=255 {
                let input = [first as u8, second as u8];
                assert_eq!(
                    validate_and_select_scalar(&input).is_ok(),
                    std::str::from_utf8(&input).is_ok()
                );
            }
        }
        for input in [
            vec![0xe0, 0xa0, 0x80],
            vec![0xed, 0x9f, 0xbf],
            vec![0xf0, 0x90, 0x80, 0x80],
            vec![0xf4, 0x8f, 0xbf, 0xbf],
            vec![0xe0, 0x9f, 0x80],
            vec![0xed, 0xa0, 0x80],
            vec![0xf0, 0x8f, 0xbf, 0xbf],
            vec![0xf4, 0x90, 0x80, 0x80],
        ] {
            assert_eq!(
                validate_and_select_scalar(&input).is_ok(),
                std::str::from_utf8(&input).is_ok()
            );
        }
    }

    #[test]
    fn applies_the_calibrated_threshold() {
        assert!(!validate_and_select_scalar(b"four ascii bytes").unwrap());
        assert!(validate_and_select_scalar("aé".as_bytes()).unwrap());
        assert!(!validate_and_select_scalar("abcdefghié".as_bytes()).unwrap());
    }

    #[test]
    fn restores_the_thread_local_route() {
        assert!(!FORCE_SCALAR.get());
        with_scalar_scanner(true, || assert!(FORCE_SCALAR.get()));
        assert!(!FORCE_SCALAR.get());
    }
}
