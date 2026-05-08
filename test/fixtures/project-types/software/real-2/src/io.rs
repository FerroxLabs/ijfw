use anyhow::Result;
use std::path::Path;

pub fn read_file(p: impl AsRef<Path>) -> Result<String> {
    Ok(std::fs::read_to_string(p)?)
}
