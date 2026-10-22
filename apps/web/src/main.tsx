import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createBrowserRouter, Navigate } from "react-router";
import { Shell } from "./App.js";
import {
  AssetsPage,
  ContentsPage,
} from "./pages.js";
import { TemplateLibraryPage } from "./features/templates/TemplateLibraryPage.js";
import { TemplateDetailPage } from "./features/templates/TemplateDetailPage.js";
import { ComposerPage } from "./features/composer/ComposerPage.js";
import { HistoryPage } from "./features/history/HistoryPage.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/contents" replace /> },
      { path: "contents", element: <ContentsPage /> },
      { path: "compose", element: <ComposerPage /> },
      { path: "contents/:id", element: <ComposerPage /> },
      { path: "contents/:id/history", element: <HistoryPage /> },
      { path: "contents/:id/edit/:renditionId", element: <HistoryPage /> },
      { path: "assets", element: <AssetsPage /> },
      { path: "templates", element: <TemplateLibraryPage /> },
      { path: "templates/:id", element: <TemplateDetailPage /> },
      { path: "*", element: <Navigate to="/contents" replace /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
