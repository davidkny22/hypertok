use std::error::Error;

const SOURCE_PREFIX: &str = "git+https://github.com/marcelroed/gigatoken";

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo:rerun-if-changed=Cargo.lock");
    let lock = std::fs::read_to_string("Cargo.lock")?;
    let package = lock
        .split("[[package]]")
        .find(|block| {
            block
                .lines()
                .any(|line| line.trim() == "name = \"gigatoken\"")
        })
        .ok_or("Cargo.lock has no gigatoken package")?;
    let version = quoted_value(package, "version").ok_or("gigatoken version is absent")?;
    let source = quoted_value(package, "source").ok_or("gigatoken source is absent")?;
    if !source.starts_with(SOURCE_PREFIX) {
        return Err(format!("unexpected gigatoken source {source}").into());
    }
    let commit = source
        .rsplit_once('#')
        .map(|(_, commit)| commit)
        .filter(|commit| commit.len() == 40 && commit.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("gigatoken source has no full commit")?;
    println!("cargo:rustc-env=GIGATOKEN_REFERENCE_VERSION={version}");
    println!("cargo:rustc-env=GIGATOKEN_REFERENCE_COMMIT={commit}");
    Ok(())
}

fn quoted_value<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    let prefix = format!("{key} = \"");
    block
        .lines()
        .map(str::trim)
        .find_map(|line| line.strip_prefix(&prefix)?.strip_suffix('"'))
}
