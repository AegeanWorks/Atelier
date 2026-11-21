import { configure } from "@testing-library/react";

// The gate suite runs many commands on one host. Testing Library's 1 s default for
// findBy* can expire while a loaded worker schedules a render, so give it a
// host-speed budget below Vitest's own 10 s test timeout. The assertions are
// unchanged: the element must still appear.
configure({ asyncUtilTimeout: 5000 });
