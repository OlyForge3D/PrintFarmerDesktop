//! Bounded library reads. SQLite filters and sorts metadata before hydrating a page.
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::catalog::{CatalogStore, LogicalModel, ModelLocation};
use crate::model::ModelFormat;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
pub enum ModelFilter {
    #[default]
    #[serde(rename = "all")]
    All,
    #[serde(rename = "favorites")]
    Favorites,
    #[serde(rename = "stl")]
    Stl,
    #[serde(rename = "threeMf")]
    ThreeMf,
    #[serde(rename = "obj")]
    Obj,
    #[serde(rename = "step")]
    Step,
    #[serde(rename = "duplicates")]
    Duplicates,
    #[serde(rename = "missing")]
    Missing,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
pub enum ModelSort {
    #[default]
    #[serde(rename = "name-asc")]
    NameAsc,
    #[serde(rename = "name-desc")]
    NameDesc,
    #[serde(rename = "size-asc")]
    SizeAsc,
    #[serde(rename = "size-desc")]
    SizeDesc,
    #[serde(rename = "date-asc")]
    DateAsc,
    #[serde(rename = "date-desc")]
    DateDesc,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelQuery {
    pub query: String,
    pub filter: ModelFilter,
    pub sort: ModelSort,
    pub collection_ids: Vec<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    pub excluded_root_ids: Vec<String>,
    pub page: usize,
    pub page_size: usize,
}

impl Default for ModelQuery {
    fn default() -> Self {
        Self {
            query: String::new(),
            filter: ModelFilter::All,
            sort: ModelSort::NameAsc,
            collection_ids: Vec::new(),
            tag_ids: Vec::new(),
            excluded_root_ids: Vec::new(),
            page: 1,
            page_size: 48,
        }
    }
}

impl ModelQuery {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=1_000_000).contains(&self.page)
            || ![24, 48, 96, 192].contains(&self.page_size)
            || self.query.len() > 16_384
            || self.collection_ids.len() > 4096
            || self.tag_ids.len() > 4096
            || self.excluded_root_ids.len() > 4096
            || self
                .collection_ids
                .iter()
                .chain(&self.tag_ids)
                .chain(&self.excluded_root_ids)
                .any(|id| id.is_empty() || id.len() > 4096)
        {
            return Err("invalid library page query".into());
        }
        Ok(())
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCounts {
    pub all: usize,
    pub favorites: usize,
    pub stl: usize,
    pub three_mf: usize,
    pub obj: usize,
    pub step: usize,
    pub duplicates: usize,
    pub missing: usize,
}

#[derive(Debug, Clone)]
pub struct SourceSummary {
    pub root_id: String,
    pub total_models: usize,
    pub available_models: usize,
    pub available_locations: usize,
    pub missing_locations: usize,
    pub sample: ModelLocation,
}

#[derive(Debug)]
pub struct ModelPage {
    pub models: Vec<LogicalModel>,
    pub counts: ModelCounts,
    pub sources: Vec<SourceSummary>,
    pub filtered_total: usize,
    pub page: usize,
    pub page_size: usize,
}

fn name(model: &LogicalModel) -> String {
    model
        .locations
        .first()
        .map(|location| {
            let relative = location.root_relative.to_string_lossy();
            let path = location.path.to_string_lossy();
            basename(if relative.is_empty() {
                &path
            } else {
                &relative
            })
            .to_owned()
        })
        .unwrap_or_else(|| model.hash.chars().take(12).collect())
}

fn basename(path: &str) -> &str {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
}

/// Case-insensitive natural ordering; leading zeroes are broken by the final hash.
pub fn compare_names(left: &str, right: &str) -> Ordering {
    let left = left.to_lowercase();
    let right = right.to_lowercase();
    let mut a = left.as_str();
    let mut b = right.as_str();
    while !a.is_empty() && !b.is_empty() {
        let ac = a.chars().next().unwrap();
        let bc = b.chars().next().unwrap();
        if ac.is_ascii_digit() && bc.is_ascii_digit() {
            let an = a.bytes().take_while(u8::is_ascii_digit).count();
            let bn = b.bytes().take_while(u8::is_ascii_digit).count();
            let av = a[..an].trim_start_matches('0');
            let bv = b[..bn].trim_start_matches('0');
            let cmp = av.len().cmp(&bv.len()).then_with(|| av.cmp(bv));
            if cmp != Ordering::Equal {
                return cmp;
            }
            a = &a[an..];
            b = &b[bn..];
        } else {
            let cmp = ac.cmp(&bc);
            if cmp != Ordering::Equal {
                return cmp;
            }
            a = &a[ac.len_utf8()..];
            b = &b[bc.len_utf8()..];
        }
    }
    a.len().cmp(&b.len())
}

pub fn query_memory<T: CatalogStore + ?Sized>(
    store: &T,
    query: &ModelQuery,
) -> Result<ModelPage, String> {
    query.validate()?;
    let excluded: HashSet<_> = query.excluded_root_ids.iter().collect();
    let favorites: HashSet<_> = store.favorite_hashes().into_iter().collect();
    let models: Vec<_> = store
        .models()
        .into_iter()
        .filter_map(|mut model| {
            model
                .locations
                .retain(|location| !excluded.contains(&location.root_id));
            model.locations.sort_by(|a, b| a.path.cmp(&b.path));
            (!model.locations.is_empty()).then_some(model)
        })
        .collect();
    let mut counts = ModelCounts::default();
    let mut roots = BTreeMap::<String, SourceSummary>::new();
    for model in &models {
        counts.all += 1;
        counts.favorites += usize::from(favorites.contains(&model.hash));
        counts.duplicates += usize::from(model.locations.len() > 1);
        counts.missing += usize::from(!model.locations.iter().any(|l| l.available));
        match model.format {
            ModelFormat::Stl => counts.stl += 1,
            ModelFormat::ThreeMf => counts.three_mf += 1,
            ModelFormat::Obj => counts.obj += 1,
            ModelFormat::Step => counts.step += 1,
        }
        let ids: HashSet<_> = model.locations.iter().map(|l| &l.root_id).collect();
        for id in ids {
            let locations: Vec<_> = model
                .locations
                .iter()
                .filter(|l| &l.root_id == id)
                .collect();
            let sample = locations
                .iter()
                .find(|l| l.available)
                .unwrap_or(&locations[0]);
            let root = roots.entry(id.clone()).or_insert_with(|| SourceSummary {
                root_id: id.clone(),
                total_models: 0,
                available_models: 0,
                available_locations: 0,
                missing_locations: 0,
                sample: (*sample).clone(),
            });
            root.total_models += 1;
            root.available_models += usize::from(locations.iter().any(|l| l.available));
            root.available_locations += locations.iter().filter(|l| l.available).count();
            root.missing_locations += locations.iter().filter(|l| !l.available).count();
            if sample.available {
                root.sample = (*sample).clone();
            }
        }
    }
    let mut matching: Vec<_> = models
        .into_iter()
        .filter(|model| matches_query(store, model, query, &favorites))
        .collect();
    matching.sort_by(|a, b| {
        let names = compare_names(&name(a), &name(b));
        let dates = |model: &LogicalModel| {
            model
                .locations
                .iter()
                .filter_map(|l| l.fingerprint.modified_unix_secs)
                .max()
        };
        let cmp = match query.sort {
            ModelSort::NameAsc => names,
            ModelSort::NameDesc => names.reverse(),
            ModelSort::SizeAsc => a.size.cmp(&b.size).then(names),
            ModelSort::SizeDesc => b.size.cmp(&a.size).then(names),
            ModelSort::DateAsc | ModelSort::DateDesc => {
                let cmp = match (dates(a), dates(b)) {
                    (None, None) => Ordering::Equal,
                    (None, _) => Ordering::Greater,
                    (_, None) => Ordering::Less,
                    (Some(a), Some(b)) => {
                        if matches!(query.sort, ModelSort::DateAsc) {
                            a.cmp(&b)
                        } else {
                            b.cmp(&a)
                        }
                    }
                };
                cmp.then(names)
            }
        };
        cmp.then_with(|| a.hash.cmp(&b.hash))
    });
    let filtered_total = matching.len();
    let page = query
        .page
        .min(filtered_total.div_ceil(query.page_size).max(1));
    Ok(ModelPage {
        models: matching
            .into_iter()
            .skip((page - 1) * query.page_size)
            .take(query.page_size)
            .collect(),
        counts,
        sources: roots.into_values().collect(),
        filtered_total,
        page,
        page_size: query.page_size,
    })
}

fn matches_query<T: CatalogStore + ?Sized>(
    store: &T,
    model: &LogicalModel,
    query: &ModelQuery,
    favorites: &HashSet<String>,
) -> bool {
    let category = match query.filter {
        ModelFilter::All => true,
        ModelFilter::Favorites => favorites.contains(&model.hash),
        ModelFilter::Stl => model.format == ModelFormat::Stl,
        ModelFilter::ThreeMf => model.format == ModelFormat::ThreeMf,
        ModelFilter::Obj => model.format == ModelFormat::Obj,
        ModelFilter::Step => model.format == ModelFormat::Step,
        ModelFilter::Duplicates => model.locations.len() > 1,
        ModelFilter::Missing => !model.locations.iter().any(|location| location.available),
    };
    let collections = query.collection_ids.is_empty()
        || store
            .collections_for_model(&model.hash)
            .iter()
            .any(|collection| query.collection_ids.contains(&collection.id));
    let tags = query.tag_ids.is_empty()
        || store
            .tags_for_model(&model.hash)
            .iter()
            .any(|tag| query.tag_ids.contains(&tag.id));
    let needle = query.query.trim().to_lowercase();
    let search = needle.is_empty()
        || format_label(model.format).to_lowercase().contains(&needle)
        || model.locations.iter().any(|location| {
            location
                .path
                .to_string_lossy()
                .to_lowercase()
                .contains(&needle)
                || location
                    .root_relative
                    .to_string_lossy()
                    .to_lowercase()
                    .contains(&needle)
        });
    category && collections && tags && search
}

pub fn matching_hashes_memory<T: CatalogStore + ?Sized>(
    store: &T,
    query: &ModelQuery,
    limit: usize,
) -> Result<Vec<String>, String> {
    query.validate()?;
    let favorites = store.favorite_hashes().into_iter().collect();
    let mut hashes: Vec<_> = store
        .models()
        .into_iter()
        .filter_map(|mut model| {
            model
                .locations
                .retain(|location| !query.excluded_root_ids.contains(&location.root_id));
            (!model.locations.is_empty() && matches_query(store, &model, query, &favorites))
                .then_some(model.hash)
        })
        .collect();
    hashes.sort();
    hashes.truncate(limit);
    Ok(hashes)
}

fn format_label(format: ModelFormat) -> &'static str {
    match format {
        ModelFormat::Stl => "stl",
        ModelFormat::ThreeMf => "threeMf",
        ModelFormat::Obj => "obj",
        ModelFormat::Step => "step",
    }
}

#[cfg(feature = "sqlite")]
mod sqlite {
    use super::*;
    use crate::model::FileFingerprint;
    use rusqlite::{functions::FunctionFlags, params, Connection, Row};
    use std::path::PathBuf;

    pub fn register(conn: &Connection) -> rusqlite::Result<()> {
        conn.create_collation("library_name", compare_names)?;
        conn.create_scalar_function(
            "library_lower",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |context| Ok(context.get::<String>(0)?.to_lowercase()),
        )?;
        conn.create_scalar_function(
            "library_basename",
            1,
            FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
            |context| Ok(basename(&context.get::<String>(0)?).to_owned()),
        )
    }

    const BASE: &str = "
        WITH visible_locations AS (
            SELECT * FROM model_locations WHERE root_id NOT IN (SELECT value FROM json_each(?1))
        ), summaries AS (
            SELECT m.hash, m.format, m.size_bytes, COUNT(l.path) copies, MAX(l.available) available,
                MAX(l.modified_unix_secs) modified,
                (SELECT library_basename(CASE WHEN first.root_relative = '' THEN first.path ELSE first.root_relative END)
                 FROM visible_locations first WHERE first.model_hash = m.hash ORDER BY first.path LIMIT 1) name,
                EXISTS(SELECT 1 FROM favorite_models f WHERE f.model_hash = m.hash) favorite
            FROM models m JOIN visible_locations l ON l.model_hash = m.hash GROUP BY m.hash
        ) ";

    fn location(row: &Row<'_>) -> rusqlite::Result<ModelLocation> {
        Ok(ModelLocation {
            root_id: row.get(0)?,
            path: PathBuf::from(row.get::<_, String>(1)?),
            root_relative: PathBuf::from(row.get::<_, String>(2)?),
            fingerprint: FileFingerprint {
                size: row.get(3)?,
                modified_unix_secs: row.get(4)?,
            },
            available: row.get::<_, i64>(5)? != 0,
        })
    }

    fn where_clause(request: &ModelQuery) -> String {
        let category = match request.filter {
            ModelFilter::All => "1",
            ModelFilter::Favorites => "s.favorite=1",
            ModelFilter::Stl => "s.format='stl'",
            ModelFilter::ThreeMf => "s.format='threeMf'",
            ModelFilter::Obj => "s.format='obj'",
            ModelFilter::Step => "s.format='step'",
            ModelFilter::Duplicates => "s.copies>1",
            ModelFilter::Missing => "s.available=0",
        };
        format!("WHERE {category}
            AND (?2='[]' OR EXISTS(SELECT 1 FROM collection_models c WHERE c.model_hash=s.hash AND c.collection_id IN (SELECT value FROM json_each(?2))))
            AND (?3='' OR instr(library_lower(s.format),?3)>0 OR EXISTS(
                SELECT 1 FROM visible_locations l WHERE l.model_hash=s.hash AND
                (instr(library_lower(l.path),?3)>0 OR instr(library_lower(l.root_relative),?3)>0)))
            AND (?4='[]' OR EXISTS(SELECT 1 FROM model_tags t WHERE t.model_hash=s.hash AND t.tag_id IN (SELECT value FROM json_each(?4))))")
    }

    pub fn matching_hashes(
        conn: &Connection,
        request: &ModelQuery,
        limit: usize,
    ) -> Result<Vec<String>, String> {
        request.validate()?;
        let excluded =
            serde_json::to_string(&request.excluded_root_ids).expect("string list serialization");
        let collections =
            serde_json::to_string(&request.collection_ids).expect("string list serialization");
        let tags = serde_json::to_string(&request.tag_ids).expect("string list serialization");
        let run = || -> rusqlite::Result<Vec<String>> {
            conn.prepare(&format!(
                "{BASE} SELECT s.hash FROM summaries s {} ORDER BY s.hash LIMIT ?5",
                where_clause(request)
            ))?
            .query_map(
                params![
                    excluded,
                    collections,
                    request.query.trim().to_lowercase(),
                    tags,
                    limit
                ],
                |row| row.get(0),
            )?
            .collect()
        };
        run().map_err(|error| format!("catalog selection query failed: {error}"))
    }

    pub fn query(conn: &Connection, request: &ModelQuery) -> Result<ModelPage, String> {
        request.validate()?;
        let run = || -> rusqlite::Result<ModelPage> {
            let transaction = conn.unchecked_transaction()?;
            let excluded = serde_json::to_string(&request.excluded_root_ids)
                .expect("string list serialization");
            let collections =
                serde_json::to_string(&request.collection_ids).expect("string list serialization");
            let tags = serde_json::to_string(&request.tag_ids).expect("string list serialization");
            let counts = transaction.query_row(
                &format!(
                    "{BASE} SELECT COUNT(*), COALESCE(SUM(favorite),0),
                    COALESCE(SUM(format='stl'),0), COALESCE(SUM(format='threeMf'),0),
                    COALESCE(SUM(format='obj'),0), COALESCE(SUM(format='step'),0),
                    COALESCE(SUM(copies>1),0), COALESCE(SUM(available=0),0) FROM summaries"
                ),
                [&excluded],
                |row| {
                    Ok(ModelCounts {
                        all: row.get(0)?,
                        favorites: row.get(1)?,
                        stl: row.get(2)?,
                        three_mf: row.get(3)?,
                        obj: row.get(4)?,
                        step: row.get(5)?,
                        duplicates: row.get(6)?,
                        missing: row.get(7)?,
                    })
                },
            )?;
            let where_clause = where_clause(request);
            let needle = request.query.trim().to_lowercase();
            let filtered_total: usize = transaction.query_row(
                &format!("{BASE} SELECT COUNT(*) FROM summaries s {where_clause}"),
                params![excluded, collections, needle, tags],
                |row| row.get(0),
            )?;
            let page = request
                .page
                .min(filtered_total.div_ceil(request.page_size).max(1));
            let order = match request.sort {
                ModelSort::NameAsc => "s.name COLLATE library_name ASC",
                ModelSort::NameDesc => "s.name COLLATE library_name DESC",
                ModelSort::SizeAsc => "s.size_bytes ASC, s.name COLLATE library_name ASC",
                ModelSort::SizeDesc => "s.size_bytes DESC, s.name COLLATE library_name ASC",
                ModelSort::DateAsc => {
                    "s.modified IS NULL, s.modified ASC, s.name COLLATE library_name ASC"
                }
                ModelSort::DateDesc => {
                    "s.modified IS NULL, s.modified DESC, s.name COLLATE library_name ASC"
                }
            };
            let hashes = transaction.prepare(&format!("{BASE} SELECT s.hash, s.format, s.size_bytes FROM summaries s {where_clause} ORDER BY {order}, s.hash LIMIT ?5 OFFSET ?6"))?
                .query_map(params![excluded, collections, needle, tags, request.page_size, (page-1)*request.page_size],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, u64>(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut models = Vec::with_capacity(hashes.len());
            for (hash, format, size) in hashes {
                let locations = transaction.prepare("SELECT root_id,path,root_relative,size_bytes,modified_unix_secs,available FROM model_locations WHERE model_hash=?1 AND root_id NOT IN (SELECT value FROM json_each(?2)) ORDER BY path")?
                    .query_map(params![hash, excluded], location)?.collect::<rusqlite::Result<Vec<_>>>()?;
                models.push(LogicalModel {
                    hash,
                    format: crate::sqlite_catalog::format_from_db(&format),
                    size,
                    locations,
                });
            }
            let root_rows = transaction.prepare("SELECT root_id, COUNT(DISTINCT model_hash), COUNT(DISTINCT CASE WHEN available=1 THEN model_hash END), SUM(available=1), SUM(available=0) FROM model_locations WHERE root_id NOT IN (SELECT value FROM json_each(?1)) GROUP BY root_id ORDER BY root_id")?
                .query_map([&excluded], |r| Ok((r.get::<_,String>(0)?,r.get::<_,usize>(1)?,r.get::<_,usize>(2)?,r.get::<_,usize>(3)?,r.get::<_,usize>(4)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let mut sources = Vec::new();
            for (root_id, total_models, available_models, available_locations, missing_locations) in
                root_rows
            {
                let sample = transaction.query_row("SELECT root_id,path,root_relative,size_bytes,modified_unix_secs,available FROM model_locations WHERE root_id=?1 ORDER BY available DESC,path LIMIT 1", [&root_id], location)?;
                sources.push(SourceSummary {
                    root_id,
                    total_models,
                    available_models,
                    available_locations,
                    missing_locations,
                    sample,
                });
            }
            transaction.commit()?;
            Ok(ModelPage {
                models,
                counts,
                sources,
                filtered_total,
                page,
                page_size: request.page_size,
            })
        };
        run().map_err(|error| format!("catalog page query failed: {error}"))
    }
}

#[cfg(feature = "sqlite")]
pub use sqlite::{
    matching_hashes as matching_hashes_sqlite, query as query_sqlite, register as register_sqlite,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{InMemoryCatalog, LocationUpsert};
    use crate::model::FileFingerprint;
    use std::path::PathBuf;

    fn exercise(store: &mut dyn CatalogStore) {
        store.begin_batch().unwrap();
        let a = store.create_collection("A").unwrap();
        let b = store.create_collection("B").unwrap();
        for i in 0..5001 {
            let hash = format!("hash-{i:05}");
            let path = PathBuf::from(format!("/models/model{i}.stl"));
            store.upsert_location(LocationUpsert {
                hash: hash.clone(),
                format: if i % 2 == 0 {
                    ModelFormat::Stl
                } else {
                    ModelFormat::Step
                },
                size: i + 1,
                root_id: "r".into(),
                path: path.clone(),
                root_relative: PathBuf::from(format!("model{i}.stl")),
                fingerprint: FileFingerprint {
                    size: i + 1,
                    modified_unix_secs: Some(i as i64),
                },
            });
            if i < 3000 {
                store.add_model_to_collection(&a.id, &hash);
            }
            if (2000..4500).contains(&i) {
                store.add_model_to_collection(&b.id, &hash);
            }
            if i % 1000 == 0 {
                store.add_model_tag(&hash, "Red");
            }
            if i == 4999 {
                store.add_model_tag(&hash, "Blue");
            }
            if i % 10 == 0 {
                store.set_available("r", &path, false);
            }
        }
        store.add_favorite("hash-00002");
        store.upsert_location(LocationUpsert {
            hash: "hash-00000".into(),
            format: ModelFormat::Stl,
            size: 1,
            root_id: "extra".into(),
            path: PathBuf::from("/extra/copy.stl"),
            root_relative: PathBuf::from("copy.stl"),
            fingerprint: FileFingerprint {
                size: 1,
                modified_unix_secs: None,
            },
        });
        store.commit_batch().unwrap();
        let initial = store.query_models(&ModelQuery::default()).unwrap();
        assert_eq!(initial.models.len(), 48);
        assert_eq!(initial.counts.all, 5001);
        assert_eq!(initial.counts.missing, 500);
        assert_eq!(initial.counts.duplicates, 1);
        assert_eq!(initial.counts.favorites, 1);
        assert_eq!(initial.models[2].hash, "hash-00002");
        assert_eq!(
            initial
                .sources
                .iter()
                .find(|source| source.root_id == "r")
                .unwrap()
                .total_models,
            5001
        );
        let without_copy = store
            .query_models(&ModelQuery {
                excluded_root_ids: vec!["extra".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(without_copy.counts.duplicates, 0);
        assert_eq!(without_copy.counts.missing, 501);
        let union = store
            .query_models(&ModelQuery {
                collection_ids: vec![a.id.clone(), b.id.clone()],
                page_size: 24,
                page: 9999,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(union.filtered_total, 4500);
        assert_eq!(union.page, 188);
        assert_eq!(union.models.len(), 12);
        let set: HashSet<_> = union.models.iter().map(|m| &m.hash).collect();
        assert_eq!(set.len(), union.models.len());
        let search = store
            .query_models(&ModelQuery {
                query: "MODEL4999".into(),
                page: 99,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(search.filtered_total, 1);
        assert_eq!(search.models[0].hash, "hash-04999");
        assert_eq!(search.page, 1);
        let red = store
            .all_tags()
            .into_iter()
            .find(|tag| tag.name == "Red")
            .unwrap();
        let blue = store
            .all_tags()
            .into_iter()
            .find(|tag| tag.name == "Blue")
            .unwrap();
        let any_tag = store
            .query_models(&ModelQuery {
                tag_ids: vec![red.id.clone(), blue.id.clone()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(any_tag.filtered_total, 7);
        assert_eq!(any_tag.counts.all, 5001);
        let tag_and_collections = store
            .query_models(&ModelQuery {
                tag_ids: vec![red.id.clone(), blue.id.clone()],
                collection_ids: vec![a.id.clone(), b.id.clone()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(tag_and_collections.filtered_total, 5);
        assert!(tag_and_collections
            .models
            .iter()
            .all(|model| model.hash != "hash-04999" && model.hash != "hash-05000"));
        assert_eq!(
            store
                .matching_model_hashes(
                    &ModelQuery {
                        tag_ids: vec![red.id.clone()],
                        collection_ids: vec![b.id.clone()],
                        page_size: 24,
                        ..Default::default()
                    },
                    100
                )
                .unwrap(),
            vec!["hash-02000", "hash-03000", "hash-04000"]
        );
        let unknown = store
            .query_models(&ModelQuery {
                tag_ids: vec!["no-such-tag".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(unknown.filtered_total, 0);
        assert_eq!(unknown.counts.all, 5001);
        let excluded = store
            .query_models(&ModelQuery {
                excluded_root_ids: vec!["r".into(), "extra".into()],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(excluded.counts.all, 0);
        assert!(excluded.models.is_empty());
        assert!(store
            .query_models(&ModelQuery {
                page_size: 5000,
                ..Default::default()
            })
            .is_err());
    }

    #[test]
    fn bounded_memory_pages_and_additive_collections() {
        exercise(&mut InMemoryCatalog::new());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn bounded_sqlite_pages_and_additive_collections() {
        exercise(&mut crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap());
    }

    #[cfg(feature = "sqlite")]
    #[test]
    fn unicode_literal_search_and_date_nulls_match_reference() {
        let mut memory = InMemoryCatalog::new();
        let mut sqlite = crate::sqlite_catalog::SqliteCatalog::open_in_memory().unwrap();
        for store in [&mut memory as &mut dyn CatalogStore, &mut sqlite] {
            for (i, name) in ["Étage_%'2.stl", "Étage_%'10.stl", "other.stl"]
                .iter()
                .enumerate()
            {
                store.upsert_location(LocationUpsert {
                    hash: format!("u{i}"),
                    format: ModelFormat::Stl,
                    size: 1,
                    root_id: "r".into(),
                    path: PathBuf::from(format!("/models/{name}")),
                    root_relative: PathBuf::from(name),
                    fingerprint: FileFingerprint {
                        size: 1,
                        modified_unix_secs: if i == 0 { None } else { Some(i as i64) },
                    },
                });
            }
        }
        for query in [
            ModelQuery {
                query: "ÉTAGE_%'".into(),
                ..Default::default()
            },
            ModelQuery {
                sort: ModelSort::DateDesc,
                ..Default::default()
            },
            ModelQuery {
                filter: ModelFilter::Missing,
                ..Default::default()
            },
        ] {
            let a = memory.query_models(&query).unwrap();
            let b = sqlite.query_models(&query).unwrap();
            assert_eq!(a.models, b.models);
            assert_eq!(a.counts, b.counts);
            assert_eq!(a.filtered_total, b.filtered_total);
        }
    }
}
