import { Router, type IRouter } from "express";
import healthRouter from "./health";
import customersRouter from "./customers";
import creditsRouter from "./credits";
import redemptionsRouter from "./redemptions";
import reportsRouter from "./reports";
import settingsRouter from "./settings";
import printavoRouter from "./printavo";
import rewardsRouter from "./rewards";
import storageRouter from "./storage";
import emailsRouter from "./emails";
import { requireAuth } from "../middlewares/requireAuth";

const router: IRouter = Router();

/**
 * Deliberately public endpoints (no staff auth). Everything else requires a
 * signed-in staff member. Keep this list short and explicit:
 * - /healthz                      — deployment health checks
 * - GET /credits/check/:code      — customer-facing balance check (QR target)
 * - GET /credits/:id/certificate  — certificate PDF linked from customer emails
 * - GET /storage/public-objects/* — public assets
 * - GET /storage/objects/*        — ACL-gated objects (email images must load
 *                                   for customers; non-public objects still 403)
 */
const PUBLIC_GET_PATTERNS = [
  /^\/credits\/check\/[^/]+$/,
  /^\/credits\/\d+\/certificate$/,
  /^\/storage\/public-objects\//,
  /^\/storage\/objects\//,
];

router.use((req, res, next) => {
  if (req.path === "/healthz") return next();
  if (
    req.method === "GET" &&
    PUBLIC_GET_PATTERNS.some((p) => p.test(req.path))
  ) {
    return next();
  }
  return requireAuth(req, res, next);
});

router.use(healthRouter);
router.use(customersRouter);
router.use(creditsRouter);
router.use(redemptionsRouter);
router.use(reportsRouter);
router.use(settingsRouter);
router.use(printavoRouter);
router.use(rewardsRouter);
router.use(storageRouter);
router.use(emailsRouter);

export default router;
