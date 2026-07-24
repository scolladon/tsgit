window.BENCHMARK_DATA = {
  "lastUpdate": 1784927182172,
  "repoUrl": "https://github.com/scolladon/tsgit",
  "entries": {
    "tsgit benchmarks": [
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "325a53b41e328f5f406275ee576eaaf439801d23",
          "message": "feat: notes — git-faithful add/read/list/remove on refs/notes/* (#204)",
          "timestamp": "2026-06-29T15:13:15+02:00",
          "tree_id": "8bf9e13a3ee00af7a01ee98ef4886ff3ecc16252",
          "url": "https://github.com/scolladon/tsgit/commit/325a53b41e328f5f406275ee576eaaf439801d23"
        },
        "date": 1783008548250,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.09959200000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.55252749999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1594.8814589999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 902.2597365000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.440629000000058,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.181056499999954,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.670669999999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.46374699999978,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.36537799999996423,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 94.18402049999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6122004999999717,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.43561700000009296,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32288900000003196,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3385370000000876,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7179.782471499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2913.136057000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.285153500000206,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.416537000000062,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.714465500000188,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.530068000000028,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "eb253e9ef35ff60fa7d111863702888ebb98c4be",
          "message": "chore(main): release 3.0.0 (#119)",
          "timestamp": "2026-07-02T19:58:35+02:00",
          "tree_id": "b7873e152314b7dac5e059b104c60c85f7e20471",
          "url": "https://github.com/scolladon/tsgit/commit/eb253e9ef35ff60fa7d111863702888ebb98c4be"
        },
        "date": 1783016604065,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.302995999999894,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.04181299999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1725.8805270000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 949.7222769999971,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.874919999999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.756335000000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.764230999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.90183100000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42417150000005677,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.6970809999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5999979999999141,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4528889999999137,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3383899999998903,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38282399999980044,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7835.848864500003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3134.759497000021,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.022527500000024,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.032378999999764,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.10012400000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.541697999999997,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "857039b7153f1434229ad9f9f48ccacdc59ce013",
          "message": "feat: SSH transport for clone, fetch, pull, and push (#207)",
          "timestamp": "2026-07-03T11:44:50+02:00",
          "tree_id": "86e49d40b92a0f47bacbf6f74f0049392b76c125",
          "url": "https://github.com/scolladon/tsgit/commit/857039b7153f1434229ad9f9f48ccacdc59ce013"
        },
        "date": 1783073433878,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 30.070412999999917,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.563625000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1797.0242909999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 962.3422009999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.328525000000127,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.244061999999758,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.3143634999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.89593100000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42219449999970493,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.90911400000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5924745000000939,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4082539999999426,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3564724999998816,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3674224999999751,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8147.139441000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3086.2969495001016,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.6575059999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.79384600000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.917275000000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.02115600000002,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "164b2e620ced7ce978b4945b8d847951ee1b8efa",
          "message": "feat: GPG signing — signed commits, tags, and pushes (#209)",
          "timestamp": "2026-07-04T00:06:26+02:00",
          "tree_id": "602cd8f9d4c263dc5117d47b339d1884fc77b716",
          "url": "https://github.com/scolladon/tsgit/commit/164b2e620ced7ce978b4945b8d847951ee1b8efa"
        },
        "date": 1783117893855,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.61536799999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.241895000000113,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1451.2527504999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 777.0151800000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.344720000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.201627999999914,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.60513800000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.93237500000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3117019999999684,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.4309404999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4994000000000369,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3685414999999921,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.28003000000012435,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.31648900000027425,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6700.4674620000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2580.0846305000596,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.704444500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.957413000000088,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.231012499999906,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.51443399999971,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "0bb9e8835ac9e3b58ea442755d65e9c67d2cb8a5",
          "message": "feat: smart-HTTP protocol v2 for fetch and clone, with corrected v1 fallback (#210)",
          "timestamp": "2026-07-05T09:31:50+02:00",
          "tree_id": "4591d2d51ff0f360a954b4d81efe8f3704be0859",
          "url": "https://github.com/scolladon/tsgit/commit/0bb9e8835ac9e3b58ea442755d65e9c67d2cb8a5"
        },
        "date": 1783238236825,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.89751050000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.15968399999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1454.9259614999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 774.4062509999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.55093799999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.347937000000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.381469000000038,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.65483049999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.33151900000029855,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.57281449999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5308239999999387,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3504379999999401,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25556699999992816,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34059799999999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6811.477011999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2570.7747140000574,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.211169999999811,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.04891449999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.036665999999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.731039500000179,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sébastien Colladon",
            "username": "scolladon"
          },
          "committer": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sébastien Colladon",
            "username": "scolladon"
          },
          "distinct": true,
          "id": "1656f98fd742d7dba2cc365ef4563f5695d9ae15",
          "message": "docs: reorder Phase 26 backlog into execution sequence",
          "timestamp": "2026-07-05T23:01:14+02:00",
          "tree_id": "f7c1ce3d4cb1f7d2b342a0a6db034a19b2532f53",
          "url": "https://github.com/scolladon/tsgit/commit/1656f98fd742d7dba2cc365ef4563f5695d9ae15"
        },
        "date": 1783286834947,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.29101300000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.489497000000256,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1659.4892595000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 902.8206190000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.541187500000092,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.762114999999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.790656499999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.7119715,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.37978449999991426,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.13935500000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5302675000000363,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.39253899999994246,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.29235000000016953,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3459509999997863,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7366.217122000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2979.956292000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.910802999999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.643263999999817,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.597089000000096,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.647690999999895,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "69dabf51cc2396c9d815b021fb82705c7b168871",
          "message": "refactor: centralize magic literals into named constants (#211)",
          "timestamp": "2026-07-06T09:47:26+02:00",
          "tree_id": "e2bca1e8d244e75e8e0cdc04c8882bc988520a97",
          "url": "https://github.com/scolladon/tsgit/commit/69dabf51cc2396c9d815b021fb82705c7b168871"
        },
        "date": 1783325481325,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 42.15275699999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 49.77532250000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1190.313302999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 610.5385435000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.565268999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.631575999999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.858181000000059,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 64.1488865,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25343100000009144,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 67.70911649999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3753554999999551,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2756960000001527,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2035519999999451,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22976649999986876,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5421.967176999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2047.7368060001172,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.048128999999903,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.272261999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.441587000000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.990070499999774,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "f73f9a100a93d0a00a285b9ebc5899e175db3f3e",
          "message": "feat: git-faithful branch/remote and push.default resolution (#215)",
          "timestamp": "2026-07-07T09:12:11+02:00",
          "tree_id": "4910452fad5cdfda4b8f7f24cfb6f87b78f371fb",
          "url": "https://github.com/scolladon/tsgit/commit/f73f9a100a93d0a00a285b9ebc5899e175db3f3e"
        },
        "date": 1783409866889,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.274282500000027,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.459716999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1440.7849590000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 782.274998500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.542378499999927,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.246268999999756,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.375525000000152,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.95912850000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32033599999977014,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 82.78550099999961,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5065640000000258,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34195899999997437,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.25385800000003655,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.29795850000004975,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6651.849907499996,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2551.1052990001626,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.691877499999919,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.632134499999893,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.833270999999968,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.393597000000227,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7a1dd5d493a3607ef3778a116a93d607aa618156",
          "message": "feat: zero-dependency inflate decoder for browser/memory large-entry pack clone (#216)",
          "timestamp": "2026-07-07T17:31:46+02:00",
          "tree_id": "08681398f4454df9e1bb999fdfd37651aa3f7345",
          "url": "https://github.com/scolladon/tsgit/commit/7a1dd5d493a3607ef3778a116a93d607aa618156"
        },
        "date": 1783439847184,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.322959000000083,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.320606000000225,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1753.6681500000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 965.5691689999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.28833499999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.568041999999878,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.07088349999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.13374249999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.39766400000007707,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.11791700000049,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5483159999998861,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4549765000001571,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3427209999999832,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40505800000005365,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8008.636555500005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3123.5183709999546,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.242886,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.389289999999619,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.15214500000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.093461000000389,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "c83b9326ebd3fdfb2637bee62b34375a725f82d1",
          "message": "docs: spike streaming streamInflate output cap (#217)",
          "timestamp": "2026-07-07T23:38:02+02:00",
          "tree_id": "7c7ddb3de19568f51674ad8be4a162bdd5448be4",
          "url": "https://github.com/scolladon/tsgit/commit/c83b9326ebd3fdfb2637bee62b34375a725f82d1"
        },
        "date": 1783461836866,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.174343000000135,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.29205950000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1678.944772499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 911.5363350000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.298334999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.401116499999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.141761999999972,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.34340250000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3969094999999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.20548600000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5315630000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4048539999998866,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.36166300000013507,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4164304999999331,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7546.699162499997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3296.3344459999353,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.961493000000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.022001000000046,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.115614000000278,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.10607449999975,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "b10ac0f725297e6158f6e17450b2a2e446f24270",
          "message": "docs: drop stale workers-types filter note from manifest (#218)",
          "timestamp": "2026-07-08T19:04:25+02:00",
          "tree_id": "400b063557810a0fb8de617ef0b1292616baf20c",
          "url": "https://github.com/scolladon/tsgit/commit/b10ac0f725297e6158f6e17450b2a2e446f24270"
        },
        "date": 1783531870241,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.395217499999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.36812800000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1740.1186779999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 957.5200594999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 21.91061949999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.676840500000253,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.033415000000105,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.78709650000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3804939999999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.35094850000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.601291999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3757894999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.35324199999968187,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3764059999998608,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8107.8813095000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3188.554305999889,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.171231999999918,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.181072999999742,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.56600599999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.19520999999986,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "732005096439b36ae3449776feb5c92a6f053d05",
          "message": "perf: describe early-termination traversal breaks (#219)",
          "timestamp": "2026-07-09T19:47:28+02:00",
          "tree_id": "ba2b7f4ae6372a9bf33ce5205a0c0c0aeeba0789",
          "url": "https://github.com/scolladon/tsgit/commit/732005096439b36ae3449776feb5c92a6f053d05"
        },
        "date": 1783620677341,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.558487499999956,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 39.398983000000044,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 4.839634500000045,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1103.1923235000004,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 618.6766674999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.10098599999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.062677000000122,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.118800999999962,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.66420700000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.22956999999996697,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.8948155000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.40396099999998114,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.25573449999990316,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.20616549999976996,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.24927699999989272,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6067.305302500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2417.0865540000377,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.464371000000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 6.246236999999837,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.421185500000092,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.395064000000275,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5af3f455c2821e235149a749ffe6cd866e9e7316",
          "message": "perf: prune name-rev walk at the target date cutoff (#220)",
          "timestamp": "2026-07-09T21:25:32+02:00",
          "tree_id": "864be0622f811874306b9d56f297611a7faad87e",
          "url": "https://github.com/scolladon/tsgit/commit/5af3f455c2821e235149a749ffe6cd866e9e7316"
        },
        "date": 1783626724240,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.12464200000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.264506499999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.349204500000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1763.9948949999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 961.3803404999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.03063700000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.231707000000142,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.7758284999999887,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.679458000000068,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 100.39199150000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3640720000003057,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.79284349999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5719609999998738,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4240439999998671,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3224645000000237,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3577700000000732,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8235.3115985,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3324.5810094999615,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.778802999999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.609230999999909,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.346947,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.499330500000042,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "43830781172b67c7d236d9fd75dc14a9dd894a3e",
          "message": "perf: migrate the commit priority-queue to an O(N log N) binary heap (#221)",
          "timestamp": "2026-07-10T09:20:19+02:00",
          "tree_id": "e0ae2abdb47110f93b256641041a13954b4b7564",
          "url": "https://github.com/scolladon/tsgit/commit/43830781172b67c7d236d9fd75dc14a9dd894a3e"
        },
        "date": 1783669578251,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 29.564744000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.231930499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.20085000000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1792.067652499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 956.8660605000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.644178999999895,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.859231000000364,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.685766000000058,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.573722999999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.15825200000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.39152100000001155,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.33460950000017,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6912720000000263,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.41898300000002564,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3308234999999513,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42124699999976656,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7989.658066999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3422.537743999972,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.074589999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.44623700000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.96225800000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.316294000000198,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "fc0105ff0bed1343f5ae7104ceb967763636bf35",
          "message": "perf: stop shipping source maps to shrink the npm tarball ~2× (#222)",
          "timestamp": "2026-07-10T11:15:20+02:00",
          "tree_id": "d3d7cdd097fda30ce2c131e9a42e4c2257a5dee0",
          "url": "https://github.com/scolladon/tsgit/commit/fc0105ff0bed1343f5ae7104ceb967763636bf35"
        },
        "date": 1783676491099,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.951902000000246,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.263492499999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.880758999999955,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1814.5562354999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 944.1631369999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.987138500000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.138344999999845,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.925590999999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.048005999999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.4461859999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.37649099999998725,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.43396200000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.609335000000101,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4425745000000916,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32655800000020463,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4139709999999468,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8139.436511,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3130.3074730000226,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.540230000000065,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.288460000000214,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.31499800000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.248450999999932,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "7ad7d4fabce0d3e8d22cf4de73260248d6eb953d",
          "message": "test(bench): add memory-pressure scenarios (large packs, deep delta chains) (#223)",
          "timestamp": "2026-07-10T16:51:52+02:00",
          "tree_id": "7529a0436503832015dc439704143d47423bc924",
          "url": "https://github.com/scolladon/tsgit/commit/7ad7d4fabce0d3e8d22cf4de73260248d6eb953d"
        },
        "date": 1783695652995,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.47195399999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.07001000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.054581999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6273959999998624,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.131901999999855,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6573100000000522,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.680025,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1740.0652309999987,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 934.7186785000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.7552905,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.10456000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.686202499999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.070421000000351,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.72905150000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4130929999992077,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.78485099999943,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5565010000000257,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.41532200000006014,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3426209999997809,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4259669999999005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7912.9562425,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3223.193365500003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.441269499999976,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.966781999999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.838624999999865,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.295768499999895,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "6f52886f05c610e59bc7986cf67567ea2271e996",
          "message": "chore(profile): per-command profile capture and committed baseline (#224)",
          "timestamp": "2026-07-11T16:12:38+02:00",
          "tree_id": "93638e611207099dae00b182027ac452ad28eb30",
          "url": "https://github.com/scolladon/tsgit/commit/6f52886f05c610e59bc7986cf67567ea2271e996"
        },
        "date": 1783780660231,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.06553299999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.388000499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.499586000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.693277500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.803598000000193,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5999680000002172,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.163614999999936,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1681.498321,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 939.8401555,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 20.79095099999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.274618499999974,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.871629000000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.882119500000272,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.77799700000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3609835000002022,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.6235059999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5546360000000732,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42414199999984703,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3587400000001253,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.37835699999959616,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7826.860412000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3424.056595500093,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.061425999999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.9545949999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.746456500000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.894084999999905,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5820c789438f667a648e842e9f299e2e9af4046b",
          "message": "perf: optimise the node fs containment hot path (await-gate, closure hoist, lstat parent cache) (#225)",
          "timestamp": "2026-07-12T23:37:24+02:00",
          "tree_id": "35b9dd43f9c2e49c97dc168ec79ad0f9fb3bb0e6",
          "url": "https://github.com/scolladon/tsgit/commit/5820c789438f667a648e842e9f299e2e9af4046b"
        },
        "date": 1783893680907,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 25.217044499999986,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 27.138225999999804,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.960121999999956,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.8018475000001217,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.981276999999864,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6027579999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.22245799999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1616.0949085000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 894.5029235000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.745751499999983,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.72354949999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 5.161870000000022,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.820053000000144,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.00923349999994,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3831190000000788,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 97.06964899999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6040140000000065,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3944300000000567,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2952139999999872,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34363500000017666,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5482.714292000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2897.6945054999087,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.112535500000035,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.671310000000176,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.222474499999862,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.176723000000038,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "50d3a08827a712c7ce28d81190c0fe3590d4c1c2",
          "message": "perf(blame): TREESAME skip + O(path-depth) tree descent (#229)",
          "timestamp": "2026-07-13T13:55:09+02:00",
          "tree_id": "9462fa61c5fc446e8b05bd7f6bc595b9d8644204",
          "url": "https://github.com/scolladon/tsgit/commit/50d3a08827a712c7ce28d81190c0fe3590d4c1c2"
        },
        "date": 1783945154710,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 204.95311649999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.705005999999912,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.576393499999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.92438500000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7341400000000249,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.933352500000069,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6670389999999315,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.925039999999967,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1692.1038344999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 933.2031605000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.307497000000012,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 15.44540599999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.992252000000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.078906000000188,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.2259389999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.40103850000014063,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 95.06262199999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5689424999999346,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38185999999996056,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3096134999998412,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.39568099999996775,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5838.032818000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3034.8153119999915,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.07943899999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.902417000000014,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.882988000000296,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.732005500000014,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "f5829c96d90bf2cb2d5bddbeb2b6fce1c5935d50",
          "message": "docs: publish honest competitor benchmark comparison vs isomorphic-git (#230)",
          "timestamp": "2026-07-13T16:01:42+02:00",
          "tree_id": "9fa2d654bbadb9bd4feb1e4e1fe08028f35dcb35",
          "url": "https://github.com/scolladon/tsgit/commit/f5829c96d90bf2cb2d5bddbeb2b6fce1c5935d50"
        },
        "date": 1783952805729,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 160.58275099999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 30.403984000000037,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.547478999999953,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.143350499999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5767430000000786,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.03476099999989,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5536940000001778,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.325627999999938,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1449.7327190000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 789.4188669999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.79306500000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 12.581448999999907,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.165009999999938,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.472492499999817,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.98045950000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3374080000003232,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 82.6065209999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4815150000001722,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.354153999999653,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.24435300000004645,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.34444799999982934,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5054.028534999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2546.882268999936,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.337332999999944,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.089922999999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.448203999999805,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.762842999999975,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "35ea4eca331a1956390fceec8d6f4ddabb6c7c1a",
          "message": "perf(node-fs): amortise the status:clean containment tax (#231)",
          "timestamp": "2026-07-13T21:55:35+02:00",
          "tree_id": "7d017ba030ceba38dc91882efa234cdd7f5aca82",
          "url": "https://github.com/scolladon/tsgit/commit/35ea4eca331a1956390fceec8d6f4ddabb6c7c1a"
        },
        "date": 1783974006741,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 188.46997350000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.080422,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 29.413688999999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.657709999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6204930000000104,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.787948500000084,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.6917069999999512,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.25026600000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1642.9746145,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 932.3566795000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 18.074303999999984,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.582889000000023,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.538101499999925,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.315517999999884,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.02606850000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3590439999998125,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.7491659999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5701999999998861,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.40414899999996123,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.31393949999983306,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.36188499999980195,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5913.568133500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3080.650578500121,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.803434000000038,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.954004999999597,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.042198999999982,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.681153500000164,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "8973596c281f7b0f34e88d56589d00f9e7d25021",
          "message": "ci(bench): advisory same-runner benchmark regression gate (#232)",
          "timestamp": "2026-07-14T11:03:54+02:00",
          "tree_id": "8b5d3216e64f9f6ebef8a7e690df8ffa09ca194c",
          "url": "https://github.com/scolladon/tsgit/commit/8973596c281f7b0f34e88d56589d00f9e7d25021"
        },
        "date": 1784021292691,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 188.02973550000024,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.804936499999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 30.091149000000087,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.330330499999945,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5692590000001019,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.971476999999823,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5978720000002795,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 8.29188099999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1689.825798500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 927.2937695000019,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.760796000000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.346002999999882,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.815226000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.971695500000124,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.27325149999979,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.42564700000048106,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 98.26234449999993,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6466810000000578,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.38840699999991557,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.311337500000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.37330900000006295,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5899.2915655,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 3124.366098999977,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.01156299999991,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.022009999999682,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.03097200000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 14.650285000000167,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "785d59f8755161e4958704e207a059dd1e0f2979",
          "message": "test(mutation): complete whole-codebase mutation sweep + accumulated hardening (#241)",
          "timestamp": "2026-07-22T18:49:00+02:00",
          "tree_id": "2c9dfc0aa0cf42468dc25f99ff92524c5eb4495a",
          "url": "https://github.com/scolladon/tsgit/commit/785d59f8755161e4958704e207a059dd1e0f2979"
        },
        "date": 1784740568048,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 164.43800450000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 26.178217999999788,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 28.71759099999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.71167400000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5019210000000385,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.644514999999956,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5806550000002062,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.89917650000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1454.868445,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 799.1498439999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 17.050026000000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.865179999999782,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.672706000000062,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.566455000000133,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 86.12693150000018,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.32549999999991996,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 84.89771799999971,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.5252809999999499,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3487404999999626,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2509979999999814,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3273530000001301,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5330.070508500001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1972.2451000000583,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.103870000000029,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.8151540000001205,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.475167000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.817641999999978,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "e1d52083d49fd5cbef32fbcde530ddb027535ef7",
          "message": "fix(repository): drive-letter and UNC aware commonAncestor for worktree fs (#242)",
          "timestamp": "2026-07-23T09:36:37+02:00",
          "tree_id": "831751d290381141d5fee53a33ccb07a11c8f654",
          "url": "https://github.com/scolladon/tsgit/commit/e1d52083d49fd5cbef32fbcde530ddb027535ef7"
        },
        "date": 1784793677079,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 198.85832999999957,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 30.592020000000048,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 33.30672900000036,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 14.030046500000083,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.673520999999937,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.122732999999698,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.7376519999997981,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 9.325149500000009,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1765.1819479999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 954.8824134999995,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 19.8527610000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 16.364593000000013,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.923036999999965,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.30071399999997,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 99.44901400000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.4113800000000083,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 96.99548950000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.6223849999998947,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.4022829999998976,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.3323209999998653,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.42060700000001816,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6029.051640999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 2326.018836000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.460775999999896,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.509270999999899,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 12.573259500000177,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 13.540656000000126,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "01174e170a5ec38316b5e05ab89733fcbfc59135",
          "message": "fix(merge): user-configured driver overrides the same-named built-in (#243)",
          "timestamp": "2026-07-23T14:00:26+02:00",
          "tree_id": "e84f9ef49512b030843fee5639c4bbcfe67d2e55",
          "url": "https://github.com/scolladon/tsgit/commit/01174e170a5ec38316b5e05ab89733fcbfc59135"
        },
        "date": 1784809412167,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 138.1314064999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 22.582171500000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 23.981127000000015,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.741913000000068,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5539459999998826,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.06490000000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5442440000001625,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 6.05651899999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1147.5497054999996,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 636.7788134999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.740482499999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.001694000000043,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.5587399999999434,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.60051199999998,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 93.34277900000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.23957800000016505,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.99491999999964,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.41692699999998695,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.28547549999996136,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.22666700000013407,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2532889999999952,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 4749.269389000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1871.1782165000332,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.777768000000037,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.338792000000012,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.357193000000052,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.565405000000283,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "a1caf6c3d47d13ea41f022418ab7a1cdf5f7cfaa",
          "message": "test(unit): minimise the unit test suite preserving GWT discipline (#244)",
          "timestamp": "2026-07-24T12:33:10+02:00",
          "tree_id": "30356c9ac0dccbe343f03cddd466b66f71120333",
          "url": "https://github.com/scolladon/tsgit/commit/a1caf6c3d47d13ea41f022418ab7a1cdf5f7cfaa"
        },
        "date": 1784890715149,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 156.0406065000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.931493499999988,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 31.3716629999999,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.487154000000032,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.5726069999998344,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.207929499999864,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.577694000000065,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 7.481324500000028,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1430.706255,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 780.2711490000002,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 16.538831000000073,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 11.7497075,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 4.215897000000041,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.57314099999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 91.45470849999992,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.34471650000023146,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 86.6885310000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.512407999999823,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.3360689999999522,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.24593899999990754,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.30446600000004764,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5280.190352000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1938.6455219998024,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 10.384458999999879,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 5.846459999999752,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 9.562727999999879,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 10.536802500000022,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "5fb0c9c150aeda8bfe933c5b28dcd3f402cecd5f",
          "message": "test(integration): minimise the integration test suite by collapsing scenario overlap (#245)",
          "timestamp": "2026-07-24T18:58:11+02:00",
          "tree_id": "fd1fa76fc96afd2e6881e4c4d6dff302195dfaf4",
          "url": "https://github.com/scolladon/tsgit/commit/5fb0c9c150aeda8bfe933c5b28dcd3f402cecd5f"
        },
        "date": 1784913742021,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 118.4971415,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 27.547713000000044,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 22.226932000000033,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.308328000000074,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.2055050000000165,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.939637000000062,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1963610000000244,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 5.7976770000000215,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 1105.3590520000007,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 611.8588180000006,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 13.140740999999935,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 9.766096500000003,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 3.1846340000000737,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 8.624712000000045,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 67.9247835000001,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.24182400000017878,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 66.75680000000011,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.41907100000003084,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.2597610000000259,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.18661000000020067,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22001099999988583,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3941.773305499999,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1544.6394304999849,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.91354100000035,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 4.411439999999857,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.2588009999999485,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.918889999999919,
            "unit": "ms"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "email": "colladonsebastien@gmail.com",
            "name": "Sebastien",
            "username": "scolladon"
          },
          "committer": {
            "email": "noreply@github.com",
            "name": "GitHub",
            "username": "web-flow"
          },
          "distinct": true,
          "id": "9d84ccc06b3942ae1c507f0038b87abc9b9717f2",
          "message": "docs: audit the e2e test tier and confirm it is already minimal (#246)",
          "timestamp": "2026-07-24T22:40:32+02:00",
          "tree_id": "5d74d8e7663b1b4d329bdb37c37d1449d605110a",
          "url": "https://github.com/scolladon/tsgit/commit/9d84ccc06b3942ae1c507f0038b87abc9b9717f2"
        },
        "date": 1784927181441,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "test/bench/blame-deep-ancestry.bench.ts > Given a 200-commit deep ancestry where stable.txt never changes, When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every tree > tsgit",
            "value": 117.48824850000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 15.832438000000025,
            "unit": "ms"
          },
          {
            "name": "test/bench/clone-small-repo.bench.ts > Given a local git-http-backend serving a 5-commit repo, When clone() fetches the full pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 17.840339000000085,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 6.822975000000042,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.195538000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 5.709319999999934,
            "unit": "ms"
          },
          {
            "name": "test/bench/delta-chain-read.bench.ts > Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1.1805810000000747,
            "unit": "ms"
          },
          {
            "name": "test/bench/describe.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When describe() resolves a near tag, Then the walk stops at the covered path > tsgit",
            "value": 4.814279000000056,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 936.6545845000005,
            "unit": "ms"
          },
          {
            "name": "test/bench/log-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 521.7127720000008,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > tsgit",
            "value": 11.130145000000084,
            "unit": "ms"
          },
          {
            "name": "test/bench/log.bench.ts > Given a 50-commit repo, When log() walks every commit, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 8.239478999999847,
            "unit": "ms"
          },
          {
            "name": "test/bench/name-rev.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When name-rev() names a commit a day newer than the deep history, Then the walk stops at the date cutoff > tsgit",
            "value": 2.7237040000001116,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.958425999999918,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a cold pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 83.89985850000016,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.2672019999999975,
            "unit": "ms"
          },
          {
            "name": "test/bench/pack-read-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When readBlob() reads from a warm pack, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 90.11380600000075,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.35672500000009677,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a fresh repository opened per call (cold LRU cache), When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.22909500000014305,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > tsgit",
            "value": 0.19257100000004357,
            "unit": "ms"
          },
          {
            "name": "test/bench/read-blob.bench.ts > Given a repository with a warmed LRU delta-base cache, When readBlob() reads a blob, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 0.21901300000035917,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > tsgit",
            "value": 3940.2398564999985,
            "unit": "ms"
          },
          {
            "name": "test/bench/status-scale.bench.ts > Given a medium repo (5000 commits, 20000 blobs), When status() scans the clean tree, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 1512.1739784999518,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.438073499999973,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a clean 50-commit working tree, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 4.030921999999919,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > tsgit",
            "value": 7.336755499999981,
            "unit": "ms"
          },
          {
            "name": "test/bench/status.bench.ts > Given a 50-commit working tree with 25 modified files, When status() scans it, Then compare tsgit against isomorphic-git > isomorphic-git",
            "value": 7.652399500000001,
            "unit": "ms"
          }
        ]
      }
    ]
  }
}