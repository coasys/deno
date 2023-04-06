// Copyright 2018-2023 the Deno authors. All rights reserved. MIT license.

use std::collections::HashMap;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use deno_core::anyhow::anyhow;
use deno_core::anyhow::Context;
use deno_core::error::custom_error;
use deno_core::error::AnyError;
use deno_core::futures::future::BoxFuture;
use deno_core::futures::future::Shared;
use deno_core::futures::FutureExt;
use deno_core::parking_lot::Mutex;
use deno_core::serde_json;
use deno_core::url::Url;
use deno_core::TaskQueue;
use deno_npm::registry::NpmPackageInfo;
use deno_npm::registry::NpmRegistryApi;
use once_cell::sync::Lazy;

use crate::args::CacheSetting;
use crate::cache::CACHE_PERM;
use crate::http_util::HttpClient;
use crate::util::fs::atomic_write_file;
use crate::util::progress_bar::ProgressBar;

use super::cache::should_sync_download;
use super::cache::NpmCache;

static NPM_REGISTRY_DEFAULT_URL: Lazy<Url> = Lazy::new(|| {
  let env_var_name = "NPM_CONFIG_REGISTRY";
  if let Ok(registry_url) = std::env::var(env_var_name) {
    // ensure there is a trailing slash for the directory
    let registry_url = format!("{}/", registry_url.trim_end_matches('/'));
    match Url::parse(&registry_url) {
      Ok(url) => {
        return url;
      }
      Err(err) => {
        log::debug!("Invalid {} environment variable: {:#}", env_var_name, err,);
      }
    }
  }

  Url::parse("https://registry.npmjs.org").unwrap()
});

#[derive(Clone, Debug)]
pub struct NpmRegistry(Option<Arc<NpmRegistryApiInner>>);

impl NpmRegistry {
  pub fn default_url() -> &'static Url {
    &NPM_REGISTRY_DEFAULT_URL
  }

  pub fn new(
    base_url: Url,
    cache: NpmCache,
    http_client: HttpClient,
    progress_bar: ProgressBar,
  ) -> Self {
    Self(Some(Arc::new(NpmRegistryApiInner {
      base_url,
      cache,
      mem_cache: Default::default(),
      previously_reloaded_packages: Default::default(),
      http_client,
      progress_bar,
    })))
  }

  /// Creates an npm registry API that will be uninitialized. This is
  /// useful for tests or for initializing the LSP.
  pub fn new_uninitialized() -> Self {
    Self(None)
  }

  /// Clears the internal memory cache.
  pub fn clear_memory_cache(&self) {
    self.inner().clear_memory_cache();
  }

  pub fn get_cached_package_info(
    &self,
    name: &str,
  ) -> Option<Arc<NpmPackageInfo>> {
    self.inner().get_cached_package_info(name)
  }

  pub fn base_url(&self) -> &Url {
    &self.inner().base_url
  }

  fn inner(&self) -> &Arc<NpmRegistryApiInner> {
    // this panicking indicates a bug in the code where this
    // wasn't initialized
    self.0.as_ref().unwrap()
  }
}

static SYNC_DOWNLOAD_TASK_QUEUE: Lazy<TaskQueue> =
  Lazy::new(TaskQueue::default);

#[async_trait]
impl NpmRegistryApi for NpmRegistry {
  async fn maybe_package_info(
    &self,
    name: &str,
  ) -> Result<Option<Arc<NpmPackageInfo>>, AnyError> {
    if should_sync_download() {
      let inner = self.inner().clone();
      SYNC_DOWNLOAD_TASK_QUEUE
        .queue(async move { inner.maybe_package_info(name).await })
        .await
    } else {
      self.inner().maybe_package_info(name).await
    }
  }
}

#[derive(Debug)]
enum CacheItem {
  Pending(
    Shared<BoxFuture<'static, Result<Option<Arc<NpmPackageInfo>>, String>>>,
  ),
  Resolved(Option<Arc<NpmPackageInfo>>),
}

#[derive(Debug)]
struct NpmRegistryApiInner {
  base_url: Url,
  cache: NpmCache,
  mem_cache: Mutex<HashMap<String, CacheItem>>,
  previously_reloaded_packages: Mutex<HashSet<String>>,
  http_client: HttpClient,
  progress_bar: ProgressBar,
}

impl NpmRegistryApiInner {
  pub async fn maybe_package_info(
    self: &Arc<Self>,
    name: &str,
  ) -> Result<Option<Arc<NpmPackageInfo>>, AnyError> {
    let (created, future) = {
      let mut mem_cache = self.mem_cache.lock();
      match mem_cache.get(name) {
        Some(CacheItem::Resolved(maybe_info)) => {
          return Ok(maybe_info.clone());
        }
        Some(CacheItem::Pending(future)) => (false, future.clone()),
        None => {
          if self.cache.cache_setting().should_use_for_npm_package(name)
        // if this has been previously reloaded, then try loading from the
        // file system cache
        || !self.previously_reloaded_packages.lock().insert(name.to_string())
          {
            // attempt to load from the file cache
            if let Some(info) = self.load_file_cached_package_info(name) {
              let result = Some(Arc::new(info));
              mem_cache
                .insert(name.to_string(), CacheItem::Resolved(result.clone()));
              return Ok(result);
            }
          }

          let future = {
            let api = self.clone();
            let name = name.to_string();
            async move { api.load_package_info_from_registry(&name).await }
              .boxed()
              .shared()
          };
          mem_cache
            .insert(name.to_string(), CacheItem::Pending(future.clone()));
          (true, future)
        }
      }
    };

    if created {
      match future.await {
        Ok(maybe_info) => {
          // replace the cache item to say it's resolved now
          self
            .mem_cache
            .lock()
            .insert(name.to_string(), CacheItem::Resolved(maybe_info.clone()));
          Ok(maybe_info)
        }
        Err(err) => {
          // purge the item from the cache so it loads next time
          self.mem_cache.lock().remove(name);
          Err(anyhow!("{}", err))
        }
      }
    } else {
      Ok(future.await.map_err(|err| anyhow!("{}", err))?)
    }
  }

  fn load_file_cached_package_info(
    &self,
    name: &str,
  ) -> Option<NpmPackageInfo> {
    match self.load_file_cached_package_info_result(name) {
      Ok(value) => value,
      Err(err) => {
        if cfg!(debug_assertions) {
          panic!("error loading cached npm package info for {name}: {err:#}");
        } else {
          None
        }
      }
    }
  }

  fn load_file_cached_package_info_result(
    &self,
    name: &str,
  ) -> Result<Option<NpmPackageInfo>, AnyError> {
    let file_cache_path = self.get_package_file_cache_path(name);
    let file_text = match fs::read_to_string(file_cache_path) {
      Ok(file_text) => file_text,
      Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
      Err(err) => return Err(err.into()),
    };
    match serde_json::from_str(&file_text) {
      Ok(package_info) => Ok(Some(package_info)),
      Err(err) => {
        // This scenario might mean we need to load more data from the
        // npm registry than before. So, just debug log while in debug
        // rather than panic.
        log::debug!(
          "error deserializing registry.json for '{}'. Reloading. {:?}",
          name,
          err
        );
        Ok(None)
      }
    }
  }

  fn save_package_info_to_file_cache(
    &self,
    name: &str,
    package_info: &NpmPackageInfo,
  ) {
    if let Err(err) =
      self.save_package_info_to_file_cache_result(name, package_info)
    {
      if cfg!(debug_assertions) {
        panic!("error saving cached npm package info for {name}: {err:#}");
      }
    }
  }

  fn save_package_info_to_file_cache_result(
    &self,
    name: &str,
    package_info: &NpmPackageInfo,
  ) -> Result<(), AnyError> {
    let file_cache_path = self.get_package_file_cache_path(name);
    let file_text = serde_json::to_string(&package_info)?;
    std::fs::create_dir_all(file_cache_path.parent().unwrap())?;
    atomic_write_file(&file_cache_path, file_text, CACHE_PERM)?;
    Ok(())
  }

  async fn load_package_info_from_registry(
    &self,
    name: &str,
  ) -> Result<Option<Arc<NpmPackageInfo>>, String> {
    self
      .load_package_info_from_registry_inner(name)
      .await
      .with_context(|| {
        format!(
          "Error getting response at {} for package \"{}\"",
          self.get_package_url(name),
          name
        )
      })
      .map(|info| info.map(Arc::new))
      // make cloneable
      .map_err(|err| format!("{err:#}"))
  }

  async fn load_package_info_from_registry_inner(
    &self,
    name: &str,
  ) -> Result<Option<NpmPackageInfo>, AnyError> {
    if *self.cache.cache_setting() == CacheSetting::Only {
      return Err(custom_error(
        "NotCached",
        format!(
          "An npm specifier not found in cache: \"{name}\", --cached-only is specified."
        )
      ));
    }

    let package_url = self.get_package_url(name);
    let guard = self.progress_bar.update(package_url.as_str());

    let maybe_bytes = self
      .http_client
      .download_with_progress(package_url, &guard)
      .await?;
    match maybe_bytes {
      Some(bytes) => {
        let package_info = serde_json::from_slice(&bytes)?;
        self.save_package_info_to_file_cache(name, &package_info);
        Ok(Some(package_info))
      }
      None => Ok(None),
    }
  }

  fn get_package_url(&self, name: &str) -> Url {
    self.base_url.join(name).unwrap()
  }

  fn get_package_file_cache_path(&self, name: &str) -> PathBuf {
    let name_folder_path = self.cache.package_name_folder(name, &self.base_url);
    name_folder_path.join("registry.json")
  }

  pub fn clear_memory_cache(&self) {
    self.mem_cache.lock().clear();
  }

  pub fn get_cached_package_info(
    &self,
    name: &str,
  ) -> Option<Arc<NpmPackageInfo>> {
    let mem_cache = self.mem_cache.lock();
    if let Some(CacheItem::Resolved(maybe_info)) = mem_cache.get(name) {
      maybe_info.clone()
    } else {
      None
    }
  }
}
