use clap::Parser;
use anyhow::Result;

mod merge;
mod io;

#[derive(Parser)]
#[command(name = "config-merge")]
struct Args {
    base: String,
    overlay: String,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let merged = merge::merge_files(&args.base, &args.overlay)?;
    println!("{}", merged);
    Ok(())
}
