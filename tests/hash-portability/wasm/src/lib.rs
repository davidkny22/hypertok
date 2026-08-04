use hypertok_hash::HashImage;

static IMAGE: &[u8] = include_bytes!(concat!(env!("HYPERTOK_HASH_FIXTURE_DIR"), "/image.bin"));
static INPUTS: &[u8] = include_bytes!(concat!(env!("HYPERTOK_HASH_FIXTURE_DIR"), "/inputs.bin"));

#[unsafe(no_mangle)]
pub extern "C" fn image_ptr() -> *const u8 {
    IMAGE.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn image_len() -> usize {
    IMAGE.len()
}

#[unsafe(no_mangle)]
pub extern "C" fn inputs_ptr() -> *const u8 {
    INPUTS.as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn inputs_len() -> usize {
    INPUTS.len()
}

#[unsafe(no_mangle)]
pub extern "C" fn verify() -> u32 {
    verify_image(IMAGE)
}

#[unsafe(no_mangle)]
pub extern "C" fn verify_truncated() -> u32 {
    if HashImage::from_bytes(&IMAGE[..IMAGE.len().saturating_sub(1)]).is_err() {
        0
    } else {
        1
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn verify_misses() -> u32 {
    let Ok(image) = HashImage::from_bytes(IMAGE) else {
        return 1;
    };
    for index in 0..16_384u32 {
        let mut key = [0u8; 16];
        key[0..4].copy_from_slice(b"miss");
        key[4..8].copy_from_slice(&index.to_le_bytes());
        key[8..16].copy_from_slice(&(u64::from(index) ^ 0xa5a5_5a5a_d3d3_3c3c).to_le_bytes());
        if image
            .evaluate(&key)
            .is_some_and(|value| value >= image.key_count())
        {
            return 2;
        }
    }
    0
}

fn verify_image(bytes: &[u8]) -> u32 {
    let Ok(image) = HashImage::from_bytes(bytes) else {
        return 1;
    };
    let Some(count_bytes) = INPUTS.get(0..4) else {
        return 2;
    };
    let count = u32::from_le_bytes(count_bytes.try_into().unwrap());
    if count != image.key_count() {
        return 3;
    }

    let mut cursor = 4usize;
    for _ in 0..count {
        let Some(length_bytes) = INPUTS.get(cursor..cursor + 4) else {
            return 4;
        };
        let length = u32::from_le_bytes(length_bytes.try_into().unwrap()) as usize;
        cursor += 4;
        let Some(key) = INPUTS.get(cursor..cursor + length) else {
            return 5;
        };
        cursor += length;
        let Some(expected_bytes) = INPUTS.get(cursor..cursor + 4) else {
            return 6;
        };
        let expected = u32::from_le_bytes(expected_bytes.try_into().unwrap());
        cursor += 4;
        if image.evaluate(key) != Some(expected) {
            return 7;
        }
    }
    if cursor != INPUTS.len() {
        return 8;
    }
    0
}
