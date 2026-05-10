import log4js from "log4js";

const PROCESS_LOG4JS_CONFIGURED_KEY = "__tasks_queue_log4js_configured__";

type ProcessWithLog4jsFlag = NodeJS.Process & {
  [PROCESS_LOG4JS_CONFIGURED_KEY]?: boolean;
};

const processWithFlag = process as ProcessWithLog4jsFlag;
if (!processWithFlag[PROCESS_LOG4JS_CONFIGURED_KEY]) {
  log4js.configure({
    appenders: {
      out: { type: "stdout" },
    },
    categories: {
      default: { appenders: ["out"], level: "off" },
    },
    disableClustering: true,
  });
  processWithFlag[PROCESS_LOG4JS_CONFIGURED_KEY] = true;
}
