#pragma once

#define STATE_SCENARIO_NORMAL       0
#define STATE_SCENARIO_FAIL_RECORD  1
#define STATE_SCENARIO_CANCEL       2
#define STATE_SCENARIO_TIMEOUT      3

/* Change this text-file configuration for one deterministic demo run. */
#ifndef STATE_MACHINE_SCENARIO
#define STATE_MACHINE_SCENARIO STATE_SCENARIO_NORMAL
#endif
