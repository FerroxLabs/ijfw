use anyhow::Result;
use serde_yaml::Value;

pub fn merge_files(base: &str, overlay: &str) -> Result<String> {
    let base_v: Value = serde_yaml::from_str(&std::fs::read_to_string(base)?)?;
    let over_v: Value = serde_yaml::from_str(&std::fs::read_to_string(overlay)?)?;
    let merged = deep_merge(base_v, over_v);
    Ok(serde_yaml::to_string(&merged)?)
}

fn deep_merge(a: Value, b: Value) -> Value {
    match (a, b) {
        (Value::Mapping(mut am), Value::Mapping(bm)) => {
            for (k, v) in bm {
                let cur = am.remove(&k).unwrap_or(Value::Null);
                am.insert(k, deep_merge(cur, v));
            }
            Value::Mapping(am)
        }
        (_, b) => b,
    }
}
