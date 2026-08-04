use std::collections::HashSet;
use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::mem::size_of;

use crate::{fingerprint, table_hash};

pub const DEFAULT_TABLE_LOAD_PERMILLE: u16 = 850;

#[derive(Clone, Copy, Debug)]
pub struct TableKey<'a> {
    pub id: u32,
    pub bytes: &'a [u8],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TableBuildError {
    EmptyKeySet,
    InvalidLoadPermille(u16),
    DuplicateKey,
    IdOverflow(u32),
    SizeOverflow,
    DisplacementOverflow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TableImageError {
    Truncated,
    BadMagic,
    UnsupportedVersion(u16),
    InvalidLoadPermille(u16),
    SizeOverflow,
    LengthMismatch,
    NonCanonicalSlotCount,
    InvalidOccupied(u8),
    NonZeroEmptySlot,
    InvalidId(u32),
    DuplicateId(u32),
    KeyCountMismatch { expected: u32, actual: u32 },
}

impl Display for TableImageError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Truncated => formatter.write_str("fingerprint table image is truncated"),
            Self::BadMagic => formatter.write_str("fingerprint table image has bad magic"),
            Self::UnsupportedVersion(version) => {
                write!(
                    formatter,
                    "unsupported fingerprint table image version {version}"
                )
            }
            Self::InvalidLoadPermille(value) => {
                write!(
                    formatter,
                    "fingerprint table load factor {value}/1000 is invalid"
                )
            }
            Self::SizeOverflow => formatter.write_str("fingerprint table image size overflow"),
            Self::LengthMismatch => formatter.write_str("fingerprint table image length mismatch"),
            Self::NonCanonicalSlotCount => {
                formatter.write_str("fingerprint table slot count is not canonical")
            }
            Self::InvalidOccupied(value) => {
                write!(
                    formatter,
                    "fingerprint table occupied flag {value} is invalid"
                )
            }
            Self::NonZeroEmptySlot => {
                formatter.write_str("fingerprint table empty slot contains data")
            }
            Self::InvalidId(id) => write!(formatter, "fingerprint table id {id} is out of range"),
            Self::DuplicateId(id) => write!(formatter, "fingerprint table id {id} is duplicated"),
            Self::KeyCountMismatch { expected, actual } => write!(
                formatter,
                "fingerprint table has {actual} occupied slots, expected {expected}"
            ),
        }
    }
}

impl Error for TableImageError {}

impl Display for TableBuildError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyKeySet => formatter.write_str("cannot build a table for an empty key set"),
            Self::InvalidLoadPermille(value) => {
                write!(
                    formatter,
                    "table load factor {value}/1000 is outside 1..999"
                )
            }
            Self::DuplicateKey => formatter.write_str("table key set contains a duplicate"),
            Self::IdOverflow(id) => write!(formatter, "table id {id} cannot use the slot sentinel"),
            Self::SizeOverflow => formatter.write_str("table size overflow"),
            Self::DisplacementOverflow => formatter.write_str("table displacement exceeds u16"),
        }
    }
}

impl Error for TableBuildError {}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
#[repr(C)]
struct Slot {
    id_plus_one: u32,
    displacement: u16,
    fingerprint: u8,
    occupied: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FingerprintTable {
    slots: Vec<Slot>,
    key_count: u32,
    load_permille: u16,
}

impl FingerprintTable {
    pub fn build(keys: &[TableKey<'_>], load_permille: u16) -> Result<Self, TableBuildError> {
        if keys.is_empty() {
            return Err(TableBuildError::EmptyKeySet);
        }
        if !(1..1000).contains(&load_permille) {
            return Err(TableBuildError::InvalidLoadPermille(load_permille));
        }
        let key_count = u32::try_from(keys.len()).map_err(|_| TableBuildError::SizeOverflow)?;
        let mut seen = HashSet::with_capacity(keys.len());
        if keys.iter().any(|key| !seen.insert(key.bytes)) {
            return Err(TableBuildError::DuplicateKey);
        }
        let slot_count = keys
            .len()
            .checked_mul(1000)
            .ok_or(TableBuildError::SizeOverflow)?
            .div_ceil(load_permille as usize);
        u32::try_from(slot_count).map_err(|_| TableBuildError::SizeOverflow)?;
        let mut table = Self {
            slots: vec![Slot::default(); slot_count],
            key_count,
            load_permille,
        };
        for key in keys {
            table.insert(*key)?;
        }
        Ok(table)
    }

    pub fn lookup<F>(&self, key: &[u8], mut equals: F) -> Option<u32>
    where
        F: FnMut(u32, &[u8]) -> bool,
    {
        let mut position = map64(table_hash(key), self.slots.len());
        let mut displacement = 0_u16;
        let wanted_fingerprint = fingerprint(key);
        loop {
            let slot = self.slots.get(position)?;
            if slot.occupied == 0 || slot.displacement < displacement {
                return None;
            }
            if slot.fingerprint == wanted_fingerprint {
                let id = slot.id_plus_one.checked_sub(1)?;
                if equals(id, key) {
                    return Some(id);
                }
            }
            displacement = displacement.checked_add(1)?;
            position += 1;
            if position == self.slots.len() {
                position = 0;
            }
        }
    }

    pub const fn key_count(&self) -> u32 {
        self.key_count
    }

    pub const fn load_permille(&self) -> u16 {
        self.load_permille
    }

    pub fn resident_bytes(&self) -> usize {
        self.slots.capacity() * size_of::<Slot>()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(16 + self.slots.len() * size_of::<Slot>());
        bytes.extend_from_slice(b"HTFT");
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&self.load_permille.to_le_bytes());
        bytes.extend_from_slice(&self.key_count.to_le_bytes());
        bytes.extend_from_slice(
            &u32::try_from(self.slots.len())
                .expect("built fingerprint table slot count fits u32")
                .to_le_bytes(),
        );
        for slot in &self.slots {
            bytes.extend_from_slice(&slot.id_plus_one.to_le_bytes());
            bytes.extend_from_slice(&slot.displacement.to_le_bytes());
            bytes.push(slot.fingerprint);
            bytes.push(slot.occupied);
        }
        bytes
    }

    pub fn from_bytes(bytes: &[u8], vocab_size: u32) -> Result<Self, TableImageError> {
        if bytes.len() < 16 {
            return Err(TableImageError::Truncated);
        }
        if &bytes[0..4] != b"HTFT" {
            return Err(TableImageError::BadMagic);
        }
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        if version != 1 {
            return Err(TableImageError::UnsupportedVersion(version));
        }
        let load_permille = u16::from_le_bytes([bytes[6], bytes[7]]);
        if !(1..1000).contains(&load_permille) {
            return Err(TableImageError::InvalidLoadPermille(load_permille));
        }
        let key_count = u32::from_le_bytes(bytes[8..12].try_into().expect("fixed field"));
        let slot_count_u32 = u32::from_le_bytes(bytes[12..16].try_into().expect("fixed field"));
        let slot_count =
            usize::try_from(slot_count_u32).map_err(|_| TableImageError::SizeOverflow)?;
        let expected_length = slot_count
            .checked_mul(size_of::<Slot>())
            .and_then(|length| length.checked_add(16))
            .ok_or(TableImageError::SizeOverflow)?;
        if bytes.len() != expected_length {
            return Err(TableImageError::LengthMismatch);
        }
        let canonical_count = usize::try_from(key_count)
            .map_err(|_| TableImageError::SizeOverflow)?
            .checked_mul(1000)
            .ok_or(TableImageError::SizeOverflow)?
            .div_ceil(load_permille as usize);
        if slot_count != canonical_count {
            return Err(TableImageError::NonCanonicalSlotCount);
        }
        let mut slots = Vec::with_capacity(slot_count);
        let mut ids = HashSet::with_capacity(key_count as usize);
        let mut occupied_count = 0_u32;
        for raw in bytes[16..].chunks_exact(size_of::<Slot>()) {
            let slot = Slot {
                id_plus_one: u32::from_le_bytes(raw[0..4].try_into().expect("fixed slot field")),
                displacement: u16::from_le_bytes(raw[4..6].try_into().expect("fixed slot field")),
                fingerprint: raw[6],
                occupied: raw[7],
            };
            match slot.occupied {
                0 => {
                    if slot != Slot::default() {
                        return Err(TableImageError::NonZeroEmptySlot);
                    }
                }
                1 => {
                    let id = slot
                        .id_plus_one
                        .checked_sub(1)
                        .ok_or(TableImageError::InvalidId(u32::MAX))?;
                    if id >= vocab_size {
                        return Err(TableImageError::InvalidId(id));
                    }
                    if !ids.insert(id) {
                        return Err(TableImageError::DuplicateId(id));
                    }
                    occupied_count += 1;
                }
                value => return Err(TableImageError::InvalidOccupied(value)),
            }
            slots.push(slot);
        }
        if occupied_count != key_count {
            return Err(TableImageError::KeyCountMismatch {
                expected: key_count,
                actual: occupied_count,
            });
        }
        Ok(Self {
            slots,
            key_count,
            load_permille,
        })
    }

    fn insert(&mut self, key: TableKey<'_>) -> Result<(), TableBuildError> {
        let mut position = map64(table_hash(key.bytes), self.slots.len());
        let mut incoming = Slot {
            id_plus_one: key
                .id
                .checked_add(1)
                .ok_or(TableBuildError::IdOverflow(key.id))?,
            displacement: 0,
            fingerprint: fingerprint(key.bytes),
            occupied: 1,
        };
        loop {
            let slot = &mut self.slots[position];
            if slot.occupied == 0 {
                *slot = incoming;
                return Ok(());
            }
            if slot.displacement < incoming.displacement {
                std::mem::swap(slot, &mut incoming);
            }
            incoming.displacement = incoming
                .displacement
                .checked_add(1)
                .ok_or(TableBuildError::DisplacementOverflow)?;
            position += 1;
            if position == self.slots.len() {
                position = 0;
            }
        }
    }
}

fn map64(value: u64, range: usize) -> usize {
    ((u128::from(value) * range as u128) >> 64) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slot_layout_is_pinned() {
        assert_eq!(size_of::<Slot>(), 8);
    }

    #[test]
    fn hits_misses_and_full_comparison_are_exact() {
        let raw = [b"alpha".as_slice(), b"beta", b"gamma", b"delta"];
        let keys = raw
            .iter()
            .enumerate()
            .map(|(id, bytes)| TableKey {
                id: id as u32,
                bytes,
            })
            .collect::<Vec<_>>();
        let table = FingerprintTable::build(&keys, DEFAULT_TABLE_LOAD_PERMILLE).unwrap();
        for key in &keys {
            assert_eq!(
                table.lookup(key.bytes, |id, bytes| raw[id as usize] == bytes),
                Some(key.id)
            );
        }
        assert_eq!(table.lookup(b"absent", |_, _| true), None);
        assert_eq!(table.lookup(b"alpha", |_, _| false), None);
    }

    #[test]
    fn invalid_construction_is_refused() {
        assert_eq!(
            FingerprintTable::build(&[], DEFAULT_TABLE_LOAD_PERMILLE),
            Err(TableBuildError::EmptyKeySet)
        );
        let duplicate = [
            TableKey {
                id: 0,
                bytes: b"same",
            },
            TableKey {
                id: 1,
                bytes: b"same",
            },
        ];
        assert_eq!(
            FingerprintTable::build(&duplicate, DEFAULT_TABLE_LOAD_PERMILLE),
            Err(TableBuildError::DuplicateKey)
        );
    }

    #[test]
    fn table_image_round_trip_and_corruption_refusal() {
        let raw = [b"alpha".as_slice(), b"beta", b"gamma", b"delta"];
        let keys = raw
            .iter()
            .enumerate()
            .map(|(id, bytes)| TableKey {
                id: id as u32,
                bytes,
            })
            .collect::<Vec<_>>();
        let table = FingerprintTable::build(&keys, DEFAULT_TABLE_LOAD_PERMILLE).unwrap();
        let image = table.to_bytes();
        let restored = FingerprintTable::from_bytes(&image, raw.len() as u32).unwrap();
        assert_eq!(restored, table);

        let mut corrupted = image;
        *corrupted.last_mut().unwrap() = 2;
        assert!(FingerprintTable::from_bytes(&corrupted, raw.len() as u32).is_err());
    }
}
