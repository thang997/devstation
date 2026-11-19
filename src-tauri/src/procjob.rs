//! Tiến trình con (ssh / sftp) phải CHẾT THEO app.
//!
//! Windows không tự kill tiến trình con khi tiến trình cha thoát. `RunEvent::Exit` → `kill_all` chỉ chạy
//! khi app thoát êm; tắt kiểu khác (Ctrl+C ở `npm run app:dev`, kill trong Task Manager, crash) thì
//! `ssh -N -L …` mồ côi, vẫn giữ cổng local (vd. 3306) và kết nối tới server.
//!
//! Cách chắc chắn: gắn từng tiến trình con vào một **Job Object** có `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
//! Handle của job chỉ app giữ → app chết theo BẤT KỲ cách nào thì kernel đóng handle → kill mọi tiến
//! trình trong job. Chỉ gắn ssh/sftp do app tạo (KHÔNG gắn cả tiến trình app vào job — trình cài đặt
//! cập nhật hay trình duyệt mở từ app phải sống tiếp sau khi app thoát).

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    struct Job(HANDLE);
    // Handle job chỉ dùng để gọi API kernel (an toàn giữa các luồng); giữ tới khi tiến trình thoát.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(h);
                return None;
            }
            Some(Job(h))
        })
        .as_ref()
        .map(|j| j.0)
    }

    #[cfg(test)]
    pub fn job_handle() -> HANDLE {
        job().expect("job")
    }

    pub fn adopt(pid: u32) {
        let Some(j) = job() else { return };
        unsafe {
            let p = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if p.is_null() {
                return;
            }
            AssignProcessToJobObject(j, p);
            CloseHandle(p);
        }
    }
}

/// Gắn tiến trình `pid` vào job "chết theo app" (Windows). Lỗi thì bỏ qua — vẫn còn `kill_all` lúc thoát êm.
pub fn adopt(pid: Option<u32>) {
    #[cfg(windows)]
    if let Some(pid) = pid {
        imp::adopt(pid);
    }
    #[cfg(not(windows))]
    let _ = pid; // Linux/macOS: tiến trình con nhận SIGHUP/EOF khi PTY/pipe của cha đóng.
}

#[cfg(all(test, windows))]
mod tests {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::IsProcessInJob;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    #[test]
    fn child_is_in_kill_on_close_job() {
        let mut child = std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        super::adopt(Some(child.id()));
        let job = super::imp_job_handle();
        let mut inside = 0;
        unsafe {
            let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, child.id());
            IsProcessInJob(p, job, &mut inside);
            CloseHandle(p);
        }
        let _ = child.kill();
        assert_ne!(inside, 0, "tiến trình con chưa nằm trong job");
    }
}
#[cfg(all(test, windows))]
fn imp_job_handle() -> windows_sys::Win32::Foundation::HANDLE {
    imp::job_handle()
}
