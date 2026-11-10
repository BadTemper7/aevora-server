/** Every success looks like { success: true, data }. */
export const sendSuccess = (res, data = null, statusCode = 200) =>
  res.status(statusCode).json({ success: true, data });
