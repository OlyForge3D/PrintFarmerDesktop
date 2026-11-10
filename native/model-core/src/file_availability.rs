//! Scan-scoped protection against downloading dataless File Provider content.

use std::fs::Metadata;
use std::io;

#[cfg(any(target_os = "macos", test))]
const SF_DATALESS: u32 = 0x4000_0000;

#[cfg(any(target_os = "macos", test))]
fn dataless_flags(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

pub(crate) fn is_cloud_only(metadata: &Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        dataless_flags(metadata.st_flags())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = metadata;
        false
    }
}

/// Call only within `without_materialization`: TN3150 specifies EDEADLK
/// when an access would materialize a dataless file or intermediate directory.
pub(crate) fn is_cloud_error(error: &io::Error) -> bool {
    #[cfg(target_os = "macos")]
    {
        error.raw_os_error() == Some(11)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = error;
        false
    }
}

pub(crate) fn without_materialization<T>(
    operation: impl FnOnce() -> io::Result<T>,
) -> io::Result<T> {
    #[cfg(target_os = "macos")]
    {
        let mut guard = macos::PolicyGuard::enter()?;
        let outcome = operation();
        restore_policy_outcome(outcome, || guard.restore())
    }
    #[cfg(not(target_os = "macos"))]
    {
        operation()
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn restore_policy_outcome<T>(
    outcome: io::Result<T>,
    restore: impl FnOnce() -> io::Result<()>,
) -> io::Result<T> {
    restore()?;
    outcome
}

#[cfg(target_os = "macos")]
mod macos {
    use std::io;

    // Public sys/resource.h definitions; see Apple's TN3150.
    const MATERIALIZE_DATALESS: i32 = 3;
    const THREAD: i32 = 1;
    const OFF: i32 = 1;

    unsafe extern "C" {
        fn getiopolicy_np(iotype: i32, scope: i32) -> i32;
        fn setiopolicy_np(iotype: i32, scope: i32, policy: i32) -> i32;
    }

    pub(super) struct PolicyGuard {
        previous: i32,
        active: bool,
    }

    impl PolicyGuard {
        pub(super) fn enter() -> io::Result<Self> {
            // These APIs operate on the calling thread and accept no pointers.
            let previous = unsafe { getiopolicy_np(MATERIALIZE_DATALESS, THREAD) };
            if previous < 0 {
                return Err(io::Error::other(format!(
                    "could not read dataless materialization policy: {}",
                    io::Error::last_os_error()
                )));
            }
            if unsafe { setiopolicy_np(MATERIALIZE_DATALESS, THREAD, OFF) } != 0 {
                return Err(io::Error::other(format!(
                    "could not disable dataless materialization: {}",
                    io::Error::last_os_error()
                )));
            }
            Ok(Self {
                previous,
                active: true,
            })
        }

        pub(super) fn restore(&mut self) -> io::Result<()> {
            if unsafe { setiopolicy_np(MATERIALIZE_DATALESS, THREAD, self.previous) } != 0 {
                return Err(io::Error::other(format!(
                    "could not restore dataless materialization policy: {}",
                    io::Error::last_os_error()
                )));
            }
            self.active = false;
            Ok(())
        }
    }

    impl Drop for PolicyGuard {
        fn drop(&mut self) {
            if self.active {
                if let Err(error) = self.restore() {
                    eprintln!("{error}");
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn real_thread_policy_is_off_and_restored_on_success_and_error() {
            let original = unsafe { getiopolicy_np(MATERIALIZE_DATALESS, THREAD) };
            assert!(original >= 0);
            for fails in [false, true] {
                let outcome = crate::file_availability::without_materialization(|| {
                    assert_eq!(unsafe { getiopolicy_np(MATERIALIZE_DATALESS, THREAD) }, OFF);
                    if fails {
                        Err(io::Error::other("fixture read failure"))
                    } else {
                        Ok(())
                    }
                });
                assert_eq!(outcome.is_err(), fails);
                assert_eq!(
                    unsafe { getiopolicy_np(MATERIALIZE_DATALESS, THREAD) },
                    original
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_dataless_flag_indicates_unavailable_content() {
        assert!(dataless_flags(SF_DATALESS));
        assert!(dataless_flags(SF_DATALESS | 0x20));
        for flags in [0, 0x20, 0x8000, 0x0008_0000] {
            assert!(!dataless_flags(flags));
        }
    }

    #[test]
    fn normal_and_empty_local_files_are_available() {
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(!is_cloud_only(&file.as_file().metadata().unwrap()));
    }

    #[test]
    fn permission_errors_are_not_cloud_skips() {
        assert!(!is_cloud_error(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
        assert!(!is_cloud_error(&io::Error::from(io::ErrorKind::NotFound)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn materialization_denial_has_a_specific_errno() {
        assert!(is_cloud_error(&io::Error::from_raw_os_error(11)));
        for errno in [1, 2, 13, 60] {
            assert!(!is_cloud_error(&io::Error::from_raw_os_error(errno)));
        }
    }
}
