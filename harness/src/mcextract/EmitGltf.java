package mcextract;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Turns entity-models.json into a single self-contained .gltf (embedded base64 buffer).
 *
 * Purely a convenience/sanity view of the JSON: each model becomes a glTF scene, each part a
 * node (translation + XYZ-euler rotation, matching PartPose), each cube a mesh of 24 vertices
 * with Minecraft's box-UV unwrap applied against the model's texWidth/texHeight.
 *
 * Coordinates are converted from Minecraft model space (Y down, 1 unit = 1/16 block) to glTF
 * (Y up, metres): x' = -x/16, y' = -y/16, z' = z/16.
 *
 * Usage: java -cp build mcextract.EmitGltf <entity-models.json> <out.gltf> [modelIdPrefix]
 */
public final class EmitGltf {

	public static void main(String[] args) throws Exception {
		Path in = Paths.get(args[0]);
		Path out = Paths.get(args[1]);
		String filter = args.length > 2 ? args[2] : "";
		Map<String, Object> root = (Map<String, Object>) Json.parse(new String(Files.readAllBytes(in), StandardCharsets.UTF_8));

		List<String> nodes = new ArrayList<>();
		List<String> meshes = new ArrayList<>();
		List<String> accessors = new ArrayList<>();
		List<String> bufferViews = new ArrayList<>();
		List<String> scenes = new ArrayList<>();
		ByteArrayOutputStream bin = new ByteArrayOutputStream();

		int modelCount = 0;
		for (Map.Entry<String, Object> me : root.entrySet()) {
			if (!me.getKey().startsWith(filter)) continue;
			Map<String, Object> model = (Map<String, Object>) me.getValue();
			double tw = num(model.get("texWidth")), th = num(model.get("texHeight"));
			Map<String, Object> parts = (Map<String, Object>) model.get("parts");
			List<Integer> rootNodes = new ArrayList<>();
			for (Map.Entry<String, Object> pe : parts.entrySet()) {
				rootNodes.add(emitPart(pe.getKey(), (Map<String, Object>) pe.getValue(), tw, th,
						nodes, meshes, accessors, bufferViews, bin));
			}
			// container node per model so the scene stays browsable
			int container = nodes.size();
			nodes.add("{\"name\":" + q(me.getKey()) + ",\"children\":" + rootNodes + "}");
			scenes.add("{\"name\":" + q(me.getKey()) + ",\"nodes\":[" + container + "]}");
			modelCount++;
		}

		byte[] buf = bin.toByteArray();
		StringBuilder sb = new StringBuilder();
		sb.append("{\n\"asset\":{\"version\":\"2.0\",\"generator\":\"McWebViewer harness mcextract.EmitGltf\"},\n");
		sb.append("\"scene\":0,\n\"scenes\":[").append(String.join(",", scenes)).append("],\n");
		sb.append("\"nodes\":[").append(String.join(",", nodes)).append("],\n");
		sb.append("\"meshes\":[").append(String.join(",", meshes)).append("],\n");
		sb.append("\"accessors\":[").append(String.join(",", accessors)).append("],\n");
		sb.append("\"bufferViews\":[").append(String.join(",", bufferViews)).append("],\n");
		sb.append("\"buffers\":[{\"byteLength\":").append(buf.length)
				.append(",\"uri\":\"data:application/octet-stream;base64,")
				.append(Base64.getEncoder().encodeToString(buf)).append("\"}]\n}\n");
		Files.write(out, sb.toString().getBytes(StandardCharsets.UTF_8));
		System.out.println("[gltf] " + modelCount + " models, " + nodes.size() + " nodes, "
				+ (buf.length / 1024) + " KiB binary -> " + out);
	}

	static int emitPart(String name, Map<String, Object> part, double tw, double th,
	                    List<String> nodes, List<String> meshes, List<String> accessors,
	                    List<String> bufferViews, ByteArrayOutputStream bin) {
		List<Object> pos = (List<Object>) part.get("pos");
		List<Object> rot = (List<Object>) part.get("rot");
		List<Object> cubes = (List<Object>) part.get("cubes");
		List<Integer> children = new ArrayList<>();

		int meshIdx = -1;
		if (cubes != null && !cubes.isEmpty()) meshIdx = emitMesh(name, cubes, tw, th, meshes, accessors, bufferViews, bin);

		Map<String, Object> kids = (Map<String, Object>) part.get("children");
		if (kids != null) {
			for (Map.Entry<String, Object> e : kids.entrySet())
				children.add(emitPart(e.getKey(), (Map<String, Object>) e.getValue(), tw, th, nodes, meshes, accessors, bufferViews, bin));
		}

		double[] q = eulerXyzToQuat(num(rot.get(0)), num(rot.get(1)), num(rot.get(2)));
		StringBuilder sb = new StringBuilder("{\"name\":" + q(name));
		sb.append(",\"translation\":[").append(f(-num(pos.get(0)) / 16.0)).append(",")
				.append(f(-num(pos.get(1)) / 16.0)).append(",").append(f(num(pos.get(2)) / 16.0)).append("]");
		sb.append(",\"rotation\":[").append(f(q[0])).append(",").append(f(q[1])).append(",")
				.append(f(q[2])).append(",").append(f(q[3])).append("]");
		if (meshIdx >= 0) sb.append(",\"mesh\":").append(meshIdx);
		if (!children.isEmpty()) sb.append(",\"children\":").append(children);
		sb.append("}");
		int idx = nodes.size();
		nodes.add(sb.toString());
		return idx;
	}

	static int emitMesh(String name, List<Object> cubes, double tw, double th,
	                    List<String> meshes, List<String> accessors, List<String> bufferViews,
	                    ByteArrayOutputStream bin) {
		List<Float> vp = new ArrayList<>(), vn = new ArrayList<>(), vt = new ArrayList<>();
		List<Integer> idx = new ArrayList<>();
		for (Object o : cubes) {
			Map<String, Object> c = (Map<String, Object>) o;
			List<Object> from = (List<Object>) c.get("from");
			List<Object> size = (List<Object>) c.get("size");
			List<Object> uv = (List<Object>) c.get("uv");
			List<Object> g = (List<Object>) c.get("growXYZ");
			boolean mirror = Boolean.TRUE.equals(c.get("mirror"));
			double gx = num(g.get(0)), gy = num(g.get(1)), gz = num(g.get(2));
			double w = num(size.get(0)), h = num(size.get(1)), d = num(size.get(2));
			double x0 = num(from.get(0)) - gx, y0 = num(from.get(1)) - gy, z0 = num(from.get(2)) - gz;
			double x1 = num(from.get(0)) + w + gx, y1 = num(from.get(1)) + h + gy, z1 = num(from.get(2)) + d + gz;
			if (mirror) { double t = x0; x0 = x1; x1 = t; }   // vanilla ModelPart.Cube swaps the X extents
			double u = num(uv.get(0)), v = num(uv.get(1));

			// vanilla ModelPart.Cube vertex naming
			double[] v1 = {x0, y0, z0}, v2 = {x1, y0, z0}, v3 = {x1, y1, z0}, v4 = {x0, y1, z0};
			double[] v5 = {x0, y0, z1}, v6 = {x1, y0, z1}, v7 = {x1, y1, z1}, v8 = {x0, y1, z1};
			// vanilla u/v ruler: [WEST d][NORTH w][EAST d][SOUTH w] across, [top d][sides h] down
			double j = u, k = u + d, l = u + d + w, mm = u + d + w + w, n = u + d + w + d, oo = u + d + w + d + w;
			double p = v, qq = v + d, r = v + d + h;
			double[][][] quads = {
					{v6, v5, v1, v2},  // DOWN
					{v3, v4, v8, v7},  // UP
					{v1, v5, v8, v4},  // WEST
					{v2, v1, v4, v3},  // NORTH
					{v6, v2, v3, v7},  // EAST
					{v5, v6, v7, v8},  // SOUTH
			};
			double[][] rects = {
					{k, p, l, qq},
					{l, qq, mm, p},
					{j, qq, k, r},
					{k, qq, l, r},
					{l, qq, n, r},
					{n, qq, oo, r},
			};
			double cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
			for (int fi = 0; fi < 6; fi++) {
				double[][] Q = quads[fi];
				double[] R = rects[fi]; // u0, v0, u1, v1
				// vanilla Polygon maps vertex 0..3 to (u1,v0) (u0,v0) (u0,v1) (u1,v1)
				double[][] uvs = {{R[2], R[1]}, {R[0], R[1]}, {R[0], R[3]}, {R[2], R[3]}};
				// glTF space: x' = -x/16, y' = -y/16, z' = z/16
				double[][] P = new double[4][];
				for (int t = 0; t < 4; t++) P[t] = new double[]{-Q[t][0] / 16.0, -Q[t][1] / 16.0, Q[t][2] / 16.0};
				double[] nrm = cross(sub(P[1], P[0]), sub(P[2], P[0]));
				// point the normal away from the cube centre; mirrored cubes wind the other way
				double[] centre = {-cx / 16.0, -cy / 16.0, cz / 16.0};
				double[] mid = {(P[0][0] + P[2][0]) / 2, (P[0][1] + P[2][1]) / 2, (P[0][2] + P[2][2]) / 2};
				double[] outward = sub(mid, centre);
				boolean flip = dot(nrm, outward) < 0;
				if (flip) nrm = new double[]{-nrm[0], -nrm[1], -nrm[2]};
				nrm = norm(nrm);
				int base = vp.size() / 3;
				for (int t = 0; t < 4; t++) {
					vp.add((float) P[t][0]); vp.add((float) P[t][1]); vp.add((float) P[t][2]);
					vn.add((float) nrm[0]); vn.add((float) nrm[1]); vn.add((float) nrm[2]);
					vt.add((float) (uvs[t][0] / tw)); vt.add((float) (uvs[t][1] / th));
				}
				if (flip) {
					idx.add(base); idx.add(base + 2); idx.add(base + 1);
					idx.add(base); idx.add(base + 3); idx.add(base + 2);
				} else {
					idx.add(base); idx.add(base + 1); idx.add(base + 2);
					idx.add(base); idx.add(base + 2); idx.add(base + 3);
				}
			}
		}
		int aPos = addFloatAccessor(vp, 3, accessors, bufferViews, bin, true);
		int aNrm = addFloatAccessor(vn, 3, accessors, bufferViews, bin, false);
		int aUv = addFloatAccessor(vt, 2, accessors, bufferViews, bin, false);
		int aIdx = addIndexAccessor(idx, accessors, bufferViews, bin);
		int m = meshes.size();
		meshes.add("{\"name\":" + q(name) + ",\"primitives\":[{\"attributes\":{\"POSITION\":" + aPos
				+ ",\"NORMAL\":" + aNrm + ",\"TEXCOORD_0\":" + aUv + "},\"indices\":" + aIdx + "}]}");
		return m;
	}

	static int addFloatAccessor(List<Float> data, int comps, List<String> accessors, List<String> views,
	                            ByteArrayOutputStream bin, boolean withBounds) {
		int off = align(bin);
		ByteBuffer bb = ByteBuffer.allocate(data.size() * 4).order(ByteOrder.LITTLE_ENDIAN);
		for (float f : data) bb.putFloat(f);
		bin.write(bb.array(), 0, bb.capacity());
		int bv = views.size();
		views.add("{\"buffer\":0,\"byteOffset\":" + off + ",\"byteLength\":" + (data.size() * 4) + ",\"target\":34962}");
		String type = comps == 3 ? "VEC3" : "VEC2";
		StringBuilder sb = new StringBuilder("{\"bufferView\":" + bv + ",\"componentType\":5126,\"count\":"
				+ (data.size() / comps) + ",\"type\":\"" + type + "\"");
		if (withBounds) {
			float[] mn = new float[comps], mx = new float[comps];
			java.util.Arrays.fill(mn, Float.MAX_VALUE);
			java.util.Arrays.fill(mx, -Float.MAX_VALUE);
			for (int i = 0; i < data.size(); i++) {
				int c = i % comps;
				mn[c] = Math.min(mn[c], data.get(i));
				mx[c] = Math.max(mx[c], data.get(i));
			}
			sb.append(",\"min\":").append(java.util.Arrays.toString(mn)).append(",\"max\":").append(java.util.Arrays.toString(mx));
		}
		sb.append("}");
		int a = accessors.size();
		accessors.add(sb.toString());
		return a;
	}

	static int addIndexAccessor(List<Integer> data, List<String> accessors, List<String> views, ByteArrayOutputStream bin) {
		int off = align(bin);
		ByteBuffer bb = ByteBuffer.allocate(data.size() * 4).order(ByteOrder.LITTLE_ENDIAN);
		for (int i : data) bb.putInt(i);
		bin.write(bb.array(), 0, bb.capacity());
		int bv = views.size();
		views.add("{\"buffer\":0,\"byteOffset\":" + off + ",\"byteLength\":" + (data.size() * 4) + ",\"target\":34963}");
		int a = accessors.size();
		accessors.add("{\"bufferView\":" + bv + ",\"componentType\":5125,\"count\":" + data.size() + ",\"type\":\"SCALAR\"}");
		return a;
	}

	static int align(ByteArrayOutputStream bin) {
		while (bin.size() % 4 != 0) bin.write(0);
		return bin.size();
	}

	/**
	 * ModelPart.translateAndRotate applies Z, then Y, then X (R = Rz * Ry * Rx).
	 * We then conjugate by the (-1,-1,1) axis flip, which is itself a 180 degree rotation
	 * about Z, so the resulting quaternion has its X and Y components negated.
	 */
	static double[] eulerXyzToQuat(double x, double y, double z) {
		double[] qx = {Math.sin(x / 2), 0, 0, Math.cos(x / 2)};
		double[] qy = {0, Math.sin(y / 2), 0, Math.cos(y / 2)};
		double[] qz = {0, 0, Math.sin(z / 2), Math.cos(z / 2)};
		double[] q = qmul(qmul(qz, qy), qx);
		return new double[]{-q[0], -q[1], q[2], q[3]};
	}

	static double[] qmul(double[] a, double[] b) {
		return new double[]{
				a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
				a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
				a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
				a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]};
	}

	static double[] sub(double[] a, double[] b) { return new double[]{a[0] - b[0], a[1] - b[1], a[2] - b[2]}; }

	static double[] cross(double[] a, double[] b) {
		return new double[]{a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
	}

	static double dot(double[] a, double[] b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

	static double[] norm(double[] a) {
		double len = Math.sqrt(dot(a, a));
		return len == 0 ? new double[]{0, 1, 0} : new double[]{a[0] / len, a[1] / len, a[2] / len};
	}

	static double num(Object o) { return ((Number) o).doubleValue(); }

	static String f(double d) {
		if (d == Math.rint(d)) return String.valueOf((long) d);
		return String.format(java.util.Locale.ROOT, "%.6f", d);
	}

	static String q(String s) { return ExtractModels.q(s); }

	/** Minimal JSON reader; only needs to handle what ExtractModels writes. */
	static final class Json {
		private final String s;
		private int i;
		Json(String s) { this.s = s; }
		static Object parse(String s) { Json j = new Json(s); j.ws(); return j.value(); }
		void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
		Object value() {
			char c = s.charAt(i);
			switch (c) {
				case '{': return obj();
				case '[': return arr();
				case '"': return str();
				case 't': i += 4; return Boolean.TRUE;
				case 'f': i += 5; return Boolean.FALSE;
				case 'n': i += 4; return null;
				default: return numv();
			}
		}
		Map<String, Object> obj() {
			Map<String, Object> m = new LinkedHashMap<>();
			i++; ws();
			if (s.charAt(i) == '}') { i++; return m; }
			while (true) {
				ws(); String k = str(); ws(); i++; ws();
				m.put(k, value()); ws();
				if (s.charAt(i) == ',') { i++; continue; }
				i++; return m;
			}
		}
		List<Object> arr() {
			List<Object> l = new ArrayList<>();
			i++; ws();
			if (s.charAt(i) == ']') { i++; return l; }
			while (true) {
				ws(); l.add(value()); ws();
				if (s.charAt(i) == ',') { i++; continue; }
				i++; return l;
			}
		}
		String str() {
			StringBuilder sb = new StringBuilder();
			i++;
			while (s.charAt(i) != '"') {
				char c = s.charAt(i++);
				if (c == '\\') {
					char e = s.charAt(i++);
					switch (e) {
						case 'n': sb.append('\n'); break;
						case 't': sb.append('\t'); break;
						case 'r': sb.append('\r'); break;
						case 'u': sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
						default: sb.append(e);
					}
				} else sb.append(c);
			}
			i++;
			return sb.toString();
		}
		Number numv() {
			int st = i;
			while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
			return Double.parseDouble(s.substring(st, i));
		}
	}
}
