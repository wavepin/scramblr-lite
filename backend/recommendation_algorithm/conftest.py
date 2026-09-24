def pytest_runtest_logreport(report):
    # Called for each phase (setup/call/teardown). Print when a test call passes.
    if report.when == "call" and report.passed:
        try:
            print(f"PASS: {report.nodeid}")
        except Exception:
            pass
# Note: we intentionally avoid printing a second pass-summary here to prevent
# duplicate PASS lines. The per-test hook above prints each passing test.
