use std::env;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use hypertok::load_tokenizer::htk::{
    PREBUILT_BUILT_STATE_SECTION_ID, build_prebuilt_built_state_image,
};
use hypertok_converter::{Document, Section, write};
use hypertok_format::{SectionId, ValidatedFile};

fn main() -> Result<(), Box<dyn Error>> {
    let mut arguments = env::args_os().skip(1);
    let input = PathBuf::from(arguments.next().ok_or("missing input .htk path")?);
    let output = PathBuf::from(arguments.next().ok_or("missing output .htk path")?);
    if arguments.next().is_some() {
        return Err("usage: hypertok-built-state-fixture <input.htk> <output.htk>".into());
    }

    let source = fs::read(&input)?;
    let file = ValidatedFile::read(&source)?;
    let image = build_prebuilt_built_state_image(&source)?;
    let mut sections = Vec::with_capacity(file.sections().len() + 1);
    for entry in file.sections() {
        if entry.id == PREBUILT_BUILT_STATE_SECTION_ID {
            continue;
        }
        let bytes = file
            .section(entry.id)
            .ok_or("validated section disappeared")?
            .to_vec();
        sections.push(match SectionId::from_known(entry.id) {
            Some(id) => Section::new(id, bytes),
            None => Section::extension(entry.id, bytes)?,
        });
    }
    sections.push(Section::extension(
        PREBUILT_BUILT_STATE_SECTION_ID,
        image,
    )?);
    let candidate = write(&Document {
        structural_class: file.header().structural_class,
        hash_scheme: file.header().hash_scheme,
        flags: file.header().flags,
        vocab_size: file.header().vocab_size,
        omega: file.header().omega,
        sections,
    })?;
    ValidatedFile::read(&candidate)?;
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output, &candidate)?;
    println!(
        "source_bytes={} candidate_bytes={} added_bytes={}",
        source.len(),
        candidate.len(),
        candidate.len() - source.len()
    );
    Ok(())
}
